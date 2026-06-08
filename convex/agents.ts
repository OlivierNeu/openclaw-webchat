// Agent discovery cache + the M:N user↔agent join (userAgents). See
// docs/MULTI_AGENT_REDESIGN.md. The bridge `/agents` is the source of truth; this
// module caches it RESILIENTLY (a failed poll never empties the cache nor flips
// per-agent presence) and is the authorization whitelist for chat binding +
// dispatch. NO secrets — non-secret instance/agent NAMES only.

import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { requireActive, requireAdmin } from "./lib/access";

// Normalized agent descriptor the bridge `/agents` returns (and the poller relays
// into the cache). Matches bridge `NormalizedAgent` (server.ts).
const agentDescriptor = v.object({
  agentId: v.string(),
  displayName: v.union(v.string(), v.null()),
  emoji: v.union(v.string(), v.null()),
  model: v.union(v.string(), v.null()),
  isDefaultOnInstance: v.boolean(),
});

// ===========================================================================
// DISCOVERY CACHE (resilient — red-team B2 / blind-spot-1)
// ===========================================================================

async function upsertInstanceDiscovery(
  ctx: MutationCtx,
  instanceName: string,
  patch:
    | { ok: true; now: number }
    | { ok: false; error: string; now: number },
): Promise<void> {
  const existing = await ctx.db
    .query("instanceDiscovery")
    .withIndex("by_instance", (q) => q.eq("instanceName", instanceName))
    .first();
  if (patch.ok) {
    const fields = {
      instanceName,
      lastPollAt: patch.now,
      lastPollOk: true,
      lastOkAt: patch.now,
      error: undefined,
    };
    if (existing) await ctx.db.patch(existing._id, fields);
    else await ctx.db.insert("instanceDiscovery", fields);
  } else {
    // FAILURE: preserve lastOkAt (the staleness window); never erase last-good.
    if (existing) {
      await ctx.db.patch(existing._id, {
        lastPollAt: patch.now,
        lastPollOk: false,
        error: patch.error,
      });
    } else {
      await ctx.db.insert("instanceDiscovery", {
        instanceName,
        lastPollAt: patch.now,
        lastPollOk: false,
        error: patch.error,
      });
    }
  }
}

/** Apply a SUCCESSFUL discovery: upsert seen agents (presentInLastOk=true) and
 *  flip absent DISCOVERED rows to presentInLastOk=false (deleted on the gateway).
 *  NEVER deletes rows (a binding must still resolve to surface the re-bind). */
export const applyDiscovery = internalMutation({
  args: {
    instanceName: v.string(),
    agents: v.array(agentDescriptor),
    // Set ONLY when the poller has CONFIRMED (via the bridge `count`) that the
    // gateway genuinely returned zero agents — so an empty list flips absent rows
    // to deleted instead of being ignored. Default false keeps the belt-and-
    // suspenders guard for every other path (a shape-drifted [] never mass-deletes).
    allowEmpty: v.optional(v.boolean()),
  },
  handler: async (ctx, { instanceName, agents, allowEmpty }) => {
    const now = Date.now();
    await upsertInstanceDiscovery(ctx, instanceName, { ok: true, now });

    const existing = await ctx.db
      .query("agents")
      .withIndex("by_instance", (q) => q.eq("instanceName", instanceName))
      .collect();
    const byId = new Map(existing.map((e) => [e.agentId, e]));
    const seen = new Set<string>();

    for (const a of agents) {
      seen.add(a.agentId);
      const cur = byId.get(a.agentId);
      const fields = {
        displayName: a.displayName ?? undefined,
        emoji: a.emoji ?? undefined,
        model: a.model ?? undefined,
        isDefaultOnInstance: a.isDefaultOnInstance,
        source: "discovered" as const,
        presentInLastOk: true,
        lastSeenAt: now,
      };
      if (cur) await ctx.db.patch(cur._id, fields);
      else
        await ctx.db.insert("agents", {
          instanceName,
          agentId: a.agentId,
          firstSeenAt: now,
          ...fields,
        });
    }
    // Discovered rows absent from this successful poll => deleted on the gateway.
    // GUARD (red-team MAJOR 1): flip presence when the poll returned agents, OR
    // when `allowEmpty` confirms a GENUINELY empty gateway (Codex P2 — a real
    // "last agent deleted" must mark them deleted, not be ignored). A shape-drifted
    // [] (allowEmpty unset) still NEVER mass-deletes.
    if (agents.length > 0 || allowEmpty) {
      for (const e of existing) {
        if (e.source === "discovered" && e.presentInLastOk && !seen.has(e.agentId)) {
          await ctx.db.patch(e._id, { presentInLastOk: false });
        }
      }
    }
  },
});

/** Record a FAILED discovery: serve last-good, never empty / never flip presence. */
export const recordDiscoveryFailure = internalMutation({
  args: { instanceName: v.string(), error: v.string() },
  handler: async (ctx, { instanceName, error }) => {
    await upsertInstanceDiscovery(ctx, instanceName, {
      ok: false,
      error,
      now: Date.now(),
    });
  },
});

/** Cron: poll the bridge `/agents` (+ `/capabilities`) for every instance and
 *  cache the result resiliently. Mono-tenant Phase 1: the bridge ignores
 *  `?instance` and returns its single gateway's agents; the loop still works for
 *  one or many instances. */
export const pollAgentDiscovery = internalAction({
  args: {},
  handler: async (ctx) => {
    const bridgeUrl = process.env.BRIDGE_URL;
    const sharedSecret = process.env.BRIDGE_SHARED_SECRET;
    if (!bridgeUrl || !sharedSecret) return; // not configured — nothing to poll
    const base = bridgeUrl.replace(/\/$/, "");

    // Phase 1 is MONO-tenant: there is ONE bridge serving ONE gateway, but the
    // `instances` table may hold several rows (the NAS has 4). Polling every row
    // against the single BRIDGE_URL would cache the SAME gateway's agents under
    // every instance name (cache corruption — red-team MINOR). So poll ONLY the
    // instance this bridge serves: `BRIDGE_INSTANCE_NAME` when set, else the sole
    // instance when exactly one exists, else NOTHING (fail safe, never corrupt).
    const all = await ctx.runQuery(internal.agents.listInstanceNames, {});
    const served = process.env.BRIDGE_INSTANCE_NAME;
    const targets = served ? [served] : all.length === 1 ? all : [];

    for (const instanceName of targets) {
      try {
        const res = await fetch(
          `${base}/agents?instance=${encodeURIComponent(instanceName)}`,
          { method: "GET", headers: { Authorization: sharedSecret } },
        );
        if (!res.ok) {
          await ctx.runMutation(internal.agents.recordDiscoveryFailure, {
            instanceName,
            error: `http_${res.status}`,
          });
          continue;
        }
        const body = (await res.json()) as {
          agents?: Array<Record<string, unknown>>;
          count?: number;
        };
        const list = Array.isArray(body.agents) ? body.agents : [];
        // Raw gateway agent count (pre-normalization) from a NEW bridge; null when
        // the bridge is old (no `count`) — then we can't disambiguate, fail closed.
        const rawCount = typeof body.count === "number" ? body.count : null;
        const agents = list
          .map((a) => ({
            agentId: String(a.agentId ?? ""),
            displayName: typeof a.displayName === "string" ? a.displayName : null,
            emoji: typeof a.emoji === "string" ? a.emoji : null,
            model: typeof a.model === "string" ? a.model : null,
            isDefaultOnInstance: a.isDefaultOnInstance === true,
          }))
          .filter((a) => a.agentId.length > 0);
        if (agents.length === 0) {
          // GENUINELY empty gateway (new bridge confirms rawCount===0): apply the
          // empty discovery so deleted agents flip to presentInLastOk=false —
          // otherwise we keep routing to a deleted agent (Codex P2). Otherwise fail
          // CLOSED (serve last-good): rawCount===null = old bridge (can't tell);
          // rawCount>0 = shape-drift (gateway had agents, all dropped — MAJOR 1).
          if (rawCount === 0) {
            await ctx.runMutation(internal.agents.applyDiscovery, {
              instanceName,
              agents: [],
              allowEmpty: true,
            });
          } else {
            await ctx.runMutation(internal.agents.recordDiscoveryFailure, {
              instanceName,
              error: rawCount === null ? "empty_discovery" : "shape_drift",
            });
          }
          continue;
        }
        await ctx.runMutation(internal.agents.applyDiscovery, {
          instanceName,
          agents,
        });
      } catch {
        await ctx.runMutation(internal.agents.recordDiscoveryFailure, {
          instanceName,
          error: "unreachable",
        });
      }
    }
  },
});

/** Internal: the configured instance names (for the poller loop). */
export const listInstanceNames = internalQuery({
  args: {},
  handler: async (ctx): Promise<string[]> => {
    const rows = await ctx.db.query("instances").collect();
    return rows.map((r) => r.name);
  },
});

// ===========================================================================
// READ — discovered agents (admin) + the user's agents (picker / editor)
// ===========================================================================

/** Admin: discovered agents for one instance + the poll outcome (Instances tab). */
export const listAgentsForInstance = query({
  args: { instanceName: v.string() },
  handler: async (ctx, { instanceName }) => {
    await requireAdmin(ctx);
    const agents = await ctx.db
      .query("agents")
      .withIndex("by_instance", (q) => q.eq("instanceName", instanceName))
      .collect();
    const discovery = await ctx.db
      .query("instanceDiscovery")
      .withIndex("by_instance", (q) => q.eq("instanceName", instanceName))
      .first();
    return {
      agents: agents.map((a) => ({
        agentId: a.agentId,
        displayName: a.displayName ?? null,
        emoji: a.emoji ?? null,
        model: a.model ?? null,
        isDefaultOnInstance: a.isDefaultOnInstance ?? false,
        source: a.source,
        presentInLastOk: a.presentInLastOk,
      })),
      discovery: discovery
        ? {
            lastPollAt: discovery.lastPollAt,
            lastPollOk: discovery.lastPollOk,
            lastOkAt: discovery.lastOkAt ?? null,
            error: discovery.error ?? null,
          }
        : null,
    };
  },
});

type EnrichedUserAgent = {
  instanceName: string;
  agentId: string;
  isDefault: boolean;
  source: "manual" | "auto";
  displayName: string | null;
  emoji: string | null;
  model: string | null;
  kind: "openclaw" | "hermes";
  // Resolution health for the UI (red-team B2): deleted vs stale vs ok.
  state: "ok" | "deleted" | "stale" | "unknown";
};

async function enrichUserAgents(
  ctx: QueryCtx,
  userId: Id<"users">,
): Promise<EnrichedUserAgent[]> {
  const rows = await ctx.db
    .query("userAgents")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  const out: EnrichedUserAgent[] = [];
  for (const r of rows) {
    const agent = await ctx.db
      .query("agents")
      .withIndex("by_instance_agent", (q) =>
        q.eq("instanceName", r.instanceName).eq("agentId", r.agentId),
      )
      .first();
    const instance = await ctx.db
      .query("instances")
      .withIndex("by_name", (q) => q.eq("name", r.instanceName))
      .first();
    const discovery = await ctx.db
      .query("instanceDiscovery")
      .withIndex("by_instance", (q) => q.eq("instanceName", r.instanceName))
      .first();
    // state priority (mirrors routing.isDeleted — Codex P2): a KNOWN deletion
    // (agent.presentInLastOk === false, set ONLY by a successful poll and never
    // erased by a failed one) wins over "stale", so a discovery blip can NOT
    // re-offer a known-deleted agent in the picker / single-agent auto-bind.
    // Then: never polled => unknown; last poll failed (but not known-deleted) =>
    // stale; successful poll with no row => deleted; else present => ok.
    let state: EnrichedUserAgent["state"] = "ok";
    if (agent && agent.presentInLastOk === false) state = "deleted";
    else if (!discovery) state = "unknown";
    else if (!discovery.lastPollOk) state = "stale";
    else if (!agent) state = "deleted";
    out.push({
      instanceName: r.instanceName,
      agentId: r.agentId,
      isDefault: r.isDefault,
      source: r.source,
      displayName: agent?.displayName ?? null,
      emoji: agent?.emoji ?? null,
      model: agent?.model ?? null,
      kind: instance?.kind ?? "openclaw",
      state,
    });
  }
  return out;
}

/** The EFFECTIVE user's agents (impersonation-aware — red-team M3). Feeds the
 *  new-chat picker + the chat-creation gate. */
export const listMyAgents = query({
  args: {},
  handler: async (ctx) => {
    const { userId } = await requireActive(ctx);
    return enrichUserAgents(ctx, userId);
  },
});

/** Admin: one user's agents (the Users Access editor). */
export const listUserAgents = query({
  args: { profileId: v.id("profiles") },
  handler: async (ctx, { profileId }) => {
    await requireAdmin(ctx);
    const profile = await ctx.db.get(profileId);
    if (profile === null) throw new Error("Not found: profile");
    return enrichUserAgents(ctx, profile.userId);
  },
});

// ===========================================================================
// WRITE — userAgents (admin). Invariants: assign only DISCOVERED+present agents;
// exactly one default whenever >=1 row (by_user RANGE READ — red-team H3); remove
// re-elects a default (red-team H2).
// ===========================================================================

async function userIdOfProfile(
  ctx: MutationCtx,
  profileId: Id<"profiles">,
): Promise<Id<"users">> {
  const profile = await ctx.db.get(profileId);
  if (profile === null) throw new Error("Not found: profile");
  return profile.userId;
}

async function agentRow(
  ctx: MutationCtx,
  instanceName: string,
  agentId: string,
): Promise<Doc<"agents"> | null> {
  return await ctx.db
    .query("agents")
    .withIndex("by_instance_agent", (q) =>
      q.eq("instanceName", instanceName).eq("agentId", agentId),
    )
    .first();
}

/** Admin: grant a user access to a DISCOVERED agent. First agent becomes default. */
export const assignAgent = mutation({
  args: {
    profileId: v.id("profiles"),
    instanceName: v.string(),
    agentId: v.string(),
  },
  handler: async (ctx, { profileId, instanceName, agentId }) => {
    await requireAdmin(ctx);
    // Only DISCOVERED + currently-present agents are assignable. This is what
    // makes "Agent X no longer exists" structurally impossible for the admin
    // (red-team M1: manual/unverified is a separate, later path).
    const agent = await agentRow(ctx, instanceName, agentId);
    if (agent === null || agent.source !== "discovered" || !agent.presentInLastOk) {
      throw new Error(
        `Agent not assignable: ${instanceName}/${agentId} is not a discovered, present agent`,
      );
    }
    const userId = await userIdOfProfile(ctx, profileId);
    // RANGE READ over by_user (H3) — also serves as the dedupe + first-agent check.
    const existing = await ctx.db
      .query("userAgents")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    if (existing.some((r) => r.instanceName === instanceName && r.agentId === agentId)) {
      return; // idempotent — already assigned
    }
    const isFirst = existing.length === 0;
    await ctx.db.insert("userAgents", {
      userId,
      instanceName,
      agentId,
      isDefault: isFirst, // first agent is the default; else admin sets it
      source: "manual",
      createdAt: Date.now(),
    });
  },
});

/** Admin: revoke an agent. If it was the default and others remain, RE-ELECT
 *  one (red-team H2 — never leave a user with agents but no default). */
export const removeAgent = mutation({
  args: {
    profileId: v.id("profiles"),
    instanceName: v.string(),
    agentId: v.string(),
  },
  handler: async (ctx, { profileId, instanceName, agentId }) => {
    await requireAdmin(ctx);
    const userId = await userIdOfProfile(ctx, profileId);
    const rows = await ctx.db
      .query("userAgents")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    const target = rows.find(
      (r) => r.instanceName === instanceName && r.agentId === agentId,
    );
    if (!target) return; // idempotent
    await ctx.db.delete(target._id);
    if (target.isDefault) {
      const remaining = rows.filter((r) => r._id !== target._id);
      if (remaining.length > 0) {
        await ctx.db.patch(remaining[0]._id, { isDefault: true });
      }
    }
  },
});

/** Admin: set a user's default agent. Clears the previous default in the SAME
 *  mutation (range read over by_user — H3: OCC serializes concurrent writes). */
export const setDefaultAgent = mutation({
  args: {
    profileId: v.id("profiles"),
    instanceName: v.string(),
    agentId: v.string(),
  },
  handler: async (ctx, { profileId, instanceName, agentId }) => {
    await requireAdmin(ctx);
    const userId = await userIdOfProfile(ctx, profileId);
    const rows = await ctx.db
      .query("userAgents")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    const target = rows.find(
      (r) => r.instanceName === instanceName && r.agentId === agentId,
    );
    if (!target) throw new Error("Not found: userAgent (assign it first)");
    for (const r of rows) {
      const shouldBeDefault = r._id === target._id;
      if (r.isDefault !== shouldBeDefault) {
        await ctx.db.patch(r._id, { isDefault: shouldBeDefault });
      }
    }
  },
});
