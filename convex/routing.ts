// Routing resolver (valves): maps an authenticated user to an OpenClaw target.
//
// SINGLE source of truth for "which instance + agent does this user talk to".
// Resolution order (per-user override wins over group):
//   1. Per-user OVERRIDE: profile.overrideInstance (+ overrideAgentId) — an
//      explicit pin that beats the group.
//   2. GROUP: profile.groupId -> groups row:
//        - mode "per-user": agentId derived from the user's `canonical`
//          (each member gets their OWN agent / isolated session).
//        - mode "shared":   agentId = group.sharedAgentId (every member talks
//          to the SAME agent).
//   3. Unrouted: no override and no group -> null (the bridge cannot dispatch;
//      surfaced as a routing error, never a silent wrong target).
//
// SECURITY (load-bearing): this emits ONLY non-secret names — instanceName,
// agentId, canonical. Gateway tokens and device identities are NEVER here; the
// bridge maps instanceName -> token/deviceIdentity from its own env.

import { Doc } from "./_generated/dataModel";
import { QueryCtx, MutationCtx } from "./_generated/server";
import { getProfile, requireUserId } from "./lib/access";

export interface ResolvedTarget {
  instanceName: string;
  agentId: string;
  canonical: string;
  source: "override" | "group-per-user" | "group-shared";
}

export async function resolveTargetForProfile(
  ctx: QueryCtx | MutationCtx,
  profile: Doc<"profiles"> | null,
): Promise<ResolvedTarget | null> {
  if (profile === null) return null;
  const canonical = profile.canonical ?? `u-${profile.userId.slice(0, 10)}`;

  // 1. Per-user override wins.
  if (profile.overrideInstance) {
    return {
      instanceName: profile.overrideInstance,
      agentId: profile.overrideAgentId ?? canonical,
      canonical,
      source: "override",
    };
  }

  // 2. Group.
  if (profile.groupId) {
    const group = await ctx.db.get(profile.groupId);
    if (group !== null) {
      if (group.mode === "shared") {
        if (!group.sharedAgentId) return null; // misconfigured shared group
        return {
          instanceName: group.instanceName,
          agentId: group.sharedAgentId,
          canonical,
          source: "group-shared",
        };
      }
      // per-user: each member gets their own agent, derived from canonical.
      return {
        instanceName: group.instanceName,
        agentId: canonical,
        canonical,
        source: "group-per-user",
      };
    }
  }

  // 3. Unrouted.
  return null;
}

/** Resolve the CURRENT authenticated user's target (used by the bridge path). */
export async function resolveTargetForUser(
  ctx: QueryCtx | MutationCtx,
): Promise<ResolvedTarget | null> {
  const userId = await requireUserId(ctx);
  const profile = await getProfile(ctx, userId);
  return resolveTargetForProfile(ctx, profile);
}
