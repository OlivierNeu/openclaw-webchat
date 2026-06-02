// Per-user access control + RBAC, shared by the public function surface.
//
// Identity model (load-bearing):
//   - @convex-dev/auth owns the `users` table (spread via `...authTables`).
//     `getAuthUserId(ctx)` returns the stable Id<"users"> for the request.
//   - Our project fields (role, routing) live in `profiles` (1:1 with a users
//     row), keyed by that same userId, so ownership is a direct id comparison.
//
// Role model (Open WebUI style): pending -> user -> admin.
//   - The FIRST user ever to sign in becomes "admin" (bootstrap via the
//     `appMeta` singleton, which serializes concurrent first sign-ins).
//   - Every subsequent user starts "pending" (blocked) until an admin approves.
//
// ensureProfile() is the SINGLE writer of `role`: it creates the profile and
// assigns the bootstrap role exactly once. Every other function READS the role
// via requireActive/requireAdmin and never creates or mutates it.

import { getAuthUserId } from "@convex-dev/auth/server";
import { Doc, Id } from "../_generated/dataModel";
import { MutationCtx, QueryCtx } from "../_generated/server";

export type Role = "pending" | "user" | "admin";
const APP_META_KEY = "singleton";

/** Authenticated user id (Id<"users">) or throw. Does NOT check role. */
export async function requireUserId(
  ctx: QueryCtx | MutationCtx,
): Promise<Id<"users">> {
  const userId = await getAuthUserId(ctx);
  if (userId === null) {
    throw new Error("Unauthorized: authentication required");
  }
  return userId;
}

/** Read the caller's profile (or null). Read-only; never creates. */
export async function getProfile(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
): Promise<Doc<"profiles"> | null> {
  return await ctx.db
    .query("profiles")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();
}

/** A missing role is treated as "pending" (least privilege). */
export function roleOf(profile: Doc<"profiles"> | null): Role {
  return (profile?.role as Role | undefined) ?? "pending";
}

/**
 * Ensure a profile exists for the authenticated user and assign its bootstrap
 * role. The SINGLE place a role is created. Bootstrap is serialized on the
 * `appMeta` singleton:
 *   - first ever sign-in (adminAssigned false) -> this user becomes "admin"
 *     AND the flag is flipped in the same transaction;
 *   - everyone else -> "pending".
 * Two concurrent first sign-ins both read adminAssigned=false, both try to flip
 * it; Convex OCC lets one commit, retries the other, which then sees the flag
 * set and lands on "pending". No double-admin.
 *
 * MUTATIONS only (it may insert). Returns the userId.
 */
export async function ensureProfile(ctx: MutationCtx): Promise<Id<"users">> {
  const userId = await requireUserId(ctx);
  const existing = await getProfile(ctx, userId);
  if (existing !== null) {
    // Backfill a role-less legacy row to "pending" (least privilege) so the
    // rest of the code can assume a role is present after ensureProfile.
    if (existing.role === undefined) {
      await ctx.db.patch(existing._id, { role: "pending" });
    }
    return userId;
  }

  // Resolve the singleton, creating it on first ever call.
  let meta = await ctx.db
    .query("appMeta")
    .withIndex("by_key", (q) => q.eq("key", APP_META_KEY))
    .unique();
  if (meta === null) {
    const metaId = await ctx.db.insert("appMeta", {
      key: APP_META_KEY,
      adminAssigned: false,
    });
    meta = (await ctx.db.get(metaId))!;
  }

  let role: Role;
  if (!meta.adminAssigned) {
    // Claim admin. Flipping the flag here is the OCC serialization point.
    await ctx.db.patch(meta._id, { adminAssigned: true });
    role = "admin";
  } else {
    role = "pending";
  }

  // Pull display fields from the auth identity (non-secret).
  const identity = await ctx.auth.getUserIdentity();
  const email = identity?.email ?? undefined;
  const name = (identity?.name as string | undefined) ?? undefined;

  await ctx.db.insert("profiles", {
    userId,
    role,
    email,
    name,
    canonical: canonicalFromEmail(email, userId),
  });
  return userId;
}

/** Derive a stable, filesystem-safe canonical key for per-user routing. */
export function canonicalFromEmail(
  email: string | undefined,
  userId: Id<"users">,
): string {
  if (email && email.includes("@")) {
    const local = email.split("@")[0]!;
    const slug = local.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
    if (slug) return slug;
  }
  return `u-${userId.slice(0, 10)}`;
}

/**
 * Require the caller to be an ACTIVE user (role user|admin). This is the gate
 * every chat/data function must use — being merely authenticated (which a
 * "pending" user is) is NOT enough.
 */
export async function requireActive(
  ctx: QueryCtx | MutationCtx,
): Promise<{ userId: Id<"users">; role: Role; profile: Doc<"profiles"> | null }> {
  const userId = await requireUserId(ctx);
  const profile = await getProfile(ctx, userId);
  const role = roleOf(profile);
  if (role === "pending") {
    throw new Error("Forbidden: account pending approval");
  }
  return { userId, role, profile };
}

/** Require the caller to be an admin. Used by every admin.* function. */
export async function requireAdmin(
  ctx: QueryCtx | MutationCtx,
): Promise<Id<"users">> {
  const userId = await requireUserId(ctx);
  const profile = await getProfile(ctx, userId);
  if (roleOf(profile) !== "admin") {
    throw new Error("Forbidden: admin role required");
  }
  return userId;
}

/** Load a chat and assert the given user owns it. Throws otherwise. */
export async function requireOwnedChat(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
  chatId: Id<"chats">,
) {
  const chat = await ctx.db.get(chatId);
  if (chat === null) {
    throw new Error("Not found: chat does not exist");
  }
  if (chat.userId !== userId) {
    throw new Error("Forbidden: chat not owned by user");
  }
  return chat;
}
