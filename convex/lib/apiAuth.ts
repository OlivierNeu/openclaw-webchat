// API-key authentication for the /api/v1 HTTP surface (httpAction context).
//
// RUNTIME (load-bearing): httpActions run in the default Convex runtime and
// have NO `ctx.db`. So this layer:
//   - hashes the presented Bearer token here (crypto.subtle is available),
//   - resolves the key + service account + permission set via ONE internalQuery
//     (internal.apiKeys.findByHash) — the db work happens inside that query,
//   - carries the EXPANDED permission list on the principal so the permission
//     check is a pure in-memory test (no db) on the httpAction side.
//
// SECURITY: never logs or returns the plaintext key. Disabled/expired keys are
// rejected. Bumping lastUsedAt is best-effort via a fire-and-forget mutation.

import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { hashKey } from "./apikeys";
import { roleHasPermission, type Permission } from "./rbac";

/** A verified non-human principal (service account) behind an API key. */
export type ServicePrincipal = {
  type: "service";
  /** serviceAccount id as a string (for trace attribution). */
  id: string;
  roleKey: string;
  serviceAccountId: string;
  /** Expanded permission keys (the role's set, "*" already flattened). */
  permissions: string[];
};

export type AuthResult =
  | { ok: true; principal: ServicePrincipal; keyId: string }
  | { ok: false; status: 401 | 403; error: string };

/**
 * Authenticate an incoming /api/v1 request by its `Authorization: Bearer <key>`
 * header. Returns the resolved service principal on success, or a 401 result on
 * any failure (missing/garbage header, unknown/disabled/expired key, or a key
 * whose service account is disabled). Permission checks are a SEPARATE step
 * (principalHasPermission) so a route can return 403 vs 401 distinctly.
 */
export async function authenticateApiKey(
  ctx: ActionCtx,
  request: Request,
): Promise<AuthResult> {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) {
    return { ok: false, status: 401, error: "missing bearer token" };
  }
  const presented = match[1]!.trim();
  if (!presented) {
    return { ok: false, status: 401, error: "empty bearer token" };
  }

  // Hash the presented key and look it up by hash (plaintext never stored).
  const hash = await hashKey(presented);
  const resolved = await ctx.runQuery(internal.apiKeys.findByHash, { hash });
  if (resolved === null) {
    return { ok: false, status: 401, error: "invalid key" };
  }

  const { key, serviceAccount, roleKey, permissions } = resolved;
  if (key.disabled) {
    return { ok: false, status: 401, error: "key revoked" };
  }
  if (key.expiresAt !== undefined && key.expiresAt <= Date.now()) {
    return { ok: false, status: 401, error: "key expired" };
  }
  if (serviceAccount.disabled) {
    return { ok: false, status: 401, error: "service account disabled" };
  }

  // Best-effort lastUsedAt bump (do not block the request on it).
  await ctx.runMutation(internal.apiKeys.touchLastUsed, { keyId: key._id });

  const principal: ServicePrincipal = {
    type: "service",
    id: serviceAccount._id,
    roleKey,
    serviceAccountId: serviceAccount._id,
    permissions,
  };
  return { ok: true, principal, keyId: key._id };
}

/**
 * Pure permission check against a principal's pre-resolved permission set. No
 * db access — the set was expanded at authentication time (see file header).
 */
export function principalHasPermission(
  principal: ServicePrincipal,
  perm: Permission,
): boolean {
  return roleHasPermission(new Set(principal.permissions), perm);
}
