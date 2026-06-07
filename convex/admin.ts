// Admin settings surface. EVERY function here requires the admin role
// (requireAdmin derives identity via ctx.auth — never an arg). Manages users
// (roles/approval), routing groups (valves), per-user overrides, and instance
// metadata. NO secrets are read or written (gateway tokens / device identities
// live only in the bridge env; these tables hold non-secret names).

import { v } from "convex/values";
import { mutation, query, MutationCtx } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { getProfile, requireAdmin, roleOf } from "./lib/access";
import { isGrantableUserPermission } from "./lib/rbac";
import { recordAudit } from "./lib/audit";
import {
  isUiPrefKey,
  UI_PREF_SYSTEM_GATE,
  type UiPrefsObject,
  type FeaturesEnabled,
} from "./lib/uiPrefs";
import {
  applyFilter,
  filterValidator,
  type FilterConfig,
} from "./lib/filters";

// --- Per-resource filter configs (docs/FILTERS_SPEC.md) --------------------
// Applied over the VIEW objects each query returns (so q/advanced see computed
// fields like the audit labels, and never a field the view does not expose — D2).

const USERS_FILTER_CFG: FilterConfig = {
  searchFields: ["email", "name", "canonical"],
  structured: { role: { field: "role", kind: "string" } },
  advanced: false,
};

const GROUPS_FILTER_CFG: FilterConfig = {
  searchFields: ["name", "instanceName"],
  structured: { mode: { field: "mode", kind: "string" } },
  advanced: false,
};

const AUDIT_FILTER_CFG: FilterConfig = {
  searchFields: ["action", "realLabel", "targetLabel", "resourceId"],
  timeField: "at",
  structured: {
    action: { field: "action", kind: "string" },
    impersonated: { field: "impersonated", kind: "bool" },
    resource: { field: "resource", kind: "string" },
  },
  advanced: true,
};

const roleValidator = v.union(
  v.literal("pending"),
  v.literal("user"),
  v.literal("admin"),
);

// --- Users ------------------------------------------------------------------

export const listUsers = query({
  args: { filter: v.optional(filterValidator) },
  handler: async (ctx, { filter }) => {
    await requireAdmin(ctx);
    // Bounded: take the most recent N profiles. (Admin user lists are small;
    // paginate later if a deployment grows large.)
    const profiles = await ctx.db.query("profiles").order("desc").take(500);
    const views = profiles.map((p) => ({
      _id: p._id,
      userId: p.userId,
      role: roleOf(p),
      email: p.email ?? null,
      name: p.name ?? null,
      groupId: p.groupId ?? null,
      overrideInstance: p.overrideInstance ?? null,
      overrideAgentId: p.overrideAgentId ?? null,
      canonical: p.canonical ?? null,
      // Granted per-tab Settings permissions (for the grant editor; admins hold
      // every permission via the wildcard regardless of this field).
      extraPermissions: p.extraPermissions ?? [],
    }));
    // Filter in-memory over the bounded view set (the per-resource subset).
    return applyFilter(views, filter, USERS_FILTER_CFG);
  },
});

// Count current admins (used for last-admin protection).
async function adminCount(ctx: Parameters<typeof requireAdmin>[0]): Promise<number> {
  const admins = await ctx.db
    .query("profiles")
    .withIndex("by_role", (q) => q.eq("role", "admin"))
    .collect();
  return admins.length;
}

type AppRole = "pending" | "user" | "admin";

/**
 * The SINGLE guarded role-change path (M1). Both setRole and approveUser route
 * through here so the last-admin lockout guard and the impersonation-target
 * cleanup can never be bypassed by a sibling mutation. Plain helper (a mutation
 * cannot ctx.runMutation another mutation), mirroring observability's
 * writeTraceEvent single-writer pattern. Preserves D5 invariants.
 *
 * Caller must have already passed requireAdmin.
 */
async function applyRoleChange(
  ctx: MutationCtx,
  profileId: Id<"profiles">,
  role: AppRole,
): Promise<void> {
  const target = await ctx.db.get(profileId);
  if (target === null) throw new Error("Not found: profile");
  // Last-admin protection: never demote the only remaining admin (lockout).
  if (roleOf(target) === "admin" && role !== "admin") {
    if ((await adminCount(ctx)) <= 1) {
      throw new Error("Refused: cannot demote the last admin");
    }
  }
  // Security hygiene: a non-admin must not carry an impersonation target.
  // Clearing it on demotion prevents a later re-promotion from silently
  // resuming a stale impersonation (getActor already ignores it while the
  // role is non-admin; this makes the state match the role).
  const patch: { role: AppRole; impersonatingUserId?: undefined } = { role };
  if (role !== "admin") patch.impersonatingUserId = undefined;
  await ctx.db.patch(profileId, patch);
}

export const setRole = mutation({
  args: { profileId: v.id("profiles"), role: roleValidator },
  handler: async (ctx, { profileId, role }) => {
    await requireAdmin(ctx);
    await applyRoleChange(ctx, profileId, role);
  },
});

// Convenience: approve a pending user to "user". Routes through the same guarded
// path as setRole (M1) so it cannot demote the last admin nor leave a stale
// impersonation target if the target happens to be the sole admin.
export const approveUser = mutation({
  args: { profileId: v.id("profiles") },
  handler: async (ctx, { profileId }) => {
    await requireAdmin(ctx);
    await applyRoleChange(ctx, profileId, "user");
  },
});

// --- Impersonation ("view/act as a user") -----------------------------------
//
// Start records the target on the REAL admin's profile; the access layer then
// resolves the effective identity for all user-data functions. requireAdmin
// keys off the REAL identity, so an admin keeps the power to stop even while
// impersonating a non-admin. Both transitions are audited.

export const startImpersonation = mutation({
  args: { profileId: v.id("profiles") },
  handler: async (ctx, { profileId }) => {
    const realUserId = await requireAdmin(ctx);
    const target = await ctx.db.get(profileId);
    if (target === null) throw new Error("Not found: profile");
    if (target.userId === realUserId) {
      throw new Error("Refused: cannot impersonate yourself");
    }
    const realProfile = await getProfile(ctx, realUserId);
    if (realProfile === null) throw new Error("Not found: admin profile");
    await ctx.db.patch(realProfile._id, { impersonatingUserId: target.userId });
    await recordAudit(
      ctx,
      { realUserId, effectiveUserId: target.userId, impersonating: true },
      "impersonation.start",
      { resource: "user", resourceId: target.userId },
    );
  },
});

export const stopImpersonation = mutation({
  args: {},
  handler: async (ctx) => {
    const realUserId = await requireAdmin(ctx);
    const realProfile = await getProfile(ctx, realUserId);
    const wasTarget = realProfile?.impersonatingUserId;
    if (realProfile && wasTarget) {
      await ctx.db.patch(realProfile._id, { impersonatingUserId: undefined });
      await recordAudit(
        ctx,
        { realUserId, effectiveUserId: wasTarget, impersonating: true },
        "impersonation.stop",
        { resource: "user", resourceId: wasTarget },
      );
    }
  },
});

// --- Audit trail (read) -----------------------------------------------------

export const listAudit = query({
  args: { filter: v.optional(filterValidator) },
  handler: async (ctx, { filter }) => {
    await requireAdmin(ctx);
    // Most-recent first. Bounded; paginate later if a deployment grows large.
    const rows = await ctx.db.query("auditLog").order("desc").take(200);
    // Resolve userIds -> human labels (small admin dataset).
    const profiles = await ctx.db.query("profiles").take(500);
    const labelOf = (uid: Id<"users">) => {
      const p = profiles.find((x) => x.userId === uid);
      return p?.email ?? p?.name ?? p?.canonical ?? String(uid).slice(0, 8);
    };
    const views = rows.map((r) => ({
      _id: r._id,
      at: r.at,
      action: r.action,
      realLabel: labelOf(r.realUserId),
      targetLabel: r.impersonated ? labelOf(r.effectiveUserId) : null,
      impersonated: r.impersonated,
      resource: r.resource ?? null,
      resourceId: r.resourceId ?? null,
    }));
    // Filter in-memory over the VIEW objects (so q can search the COMPUTED
    // realLabel/targetLabel, which do not exist on the raw auditLog row). NOTE
    // (D1): a `filter.from` older than the bounded 200-row window is partial.
    return applyFilter(views, filter, AUDIT_FILTER_CFG);
  },
});

// --- App-wide default theme (used when a user has no preference) -----------

const APP_META_KEY = "singleton";

export const setDefaultThemeMode = mutation({
  args: {
    mode: v.union(
      v.literal("light"),
      v.literal("dark"),
      v.literal("system"),
      v.null(),
    ),
  },
  handler: async (ctx, { mode }) => {
    await requireAdmin(ctx);
    const meta = await ctx.db
      .query("appMeta")
      .withIndex("by_key", (q) => q.eq("key", APP_META_KEY))
      .unique();
    if (meta === null) {
      // appMeta is normally created at first-admin bootstrap; create defensively.
      await ctx.db.insert("appMeta", {
        key: APP_META_KEY,
        adminAssigned: true,
        defaultThemeMode: mode ?? undefined,
      });
      return;
    }
    await ctx.db.patch(meta._id, { defaultThemeMode: mode ?? undefined });
  },
});

// --- UI preferences module (admin side) ------------------------------------

/** Set the admin DEFAULT for a UI pref (inherited by users with no override).
 *  `value: null` clears it (fall back to the code default). */
export const setUiPrefDefault = mutation({
  args: { key: v.string(), value: v.union(v.boolean(), v.null()) },
  handler: async (ctx, { key, value }) => {
    await requireAdmin(ctx);
    if (!isUiPrefKey(key)) throw new Error(`Unknown UI preference: ${key}`);
    const meta = await ctx.db
      .query("appMeta")
      .withIndex("by_key", (q) => q.eq("key", APP_META_KEY))
      .unique();
    const defaults: UiPrefsObject = { ...(meta?.uiPrefDefaults ?? {}) };
    if (value === null) delete defaults[key];
    else defaults[key] = value;
    if (meta === null) {
      await ctx.db.insert("appMeta", {
        key: APP_META_KEY,
        adminAssigned: true,
        uiPrefDefaults: defaults,
      });
      return;
    }
    await ctx.db.patch(meta._id, { uiPrefDefaults: defaults });
  },
});

/** Enable/disable a system-gated feature. Until enabled, a gated UI pref stays
 *  locked/greyed and `setUiPref` rejects turning it on. */
export const setFeatureEnabled = mutation({
  args: { key: v.string(), enabled: v.boolean() },
  handler: async (ctx, { key, enabled }) => {
    await requireAdmin(ctx);
    const validGates = new Set(Object.values(UI_PREF_SYSTEM_GATE));
    if (!validGates.has(key)) throw new Error(`Unknown system feature: ${key}`);
    const meta = await ctx.db
      .query("appMeta")
      .withIndex("by_key", (q) => q.eq("key", APP_META_KEY))
      .unique();
    const fe: FeaturesEnabled = { ...(meta?.featuresEnabled ?? {}) };
    fe[key] = enabled;
    if (meta === null) {
      await ctx.db.insert("appMeta", {
        key: APP_META_KEY,
        adminAssigned: true,
        featuresEnabled: fe,
      });
      return;
    }
    await ctx.db.patch(meta._id, { featuresEnabled: fe });
  },
});

// --- Integrations: NON-SECRET config (Settings › Intégrations) -------------
// Stores only non-secret knobs (host/baseUrl/workspace/enabled + tts/talk
// settings). API KEYS are NEVER accepted here — they live in deployment env.
// Each provided section is shallow-merged into the singleton so updating one
// field never clears the others; an empty string clears a field (config.ts then
// falls back to env -> default).
const INTEGRATION_CONFIG_KEY = "singleton";

export const setIntegrationConfig = mutation({
  args: {
    langfuse: v.optional(
      v.object({
        host: v.optional(v.string()),
        enabled: v.optional(v.boolean()),
      }),
    ),
    opik: v.optional(
      v.object({
        baseUrl: v.optional(v.string()),
        workspace: v.optional(v.string()),
        enabled: v.optional(v.boolean()),
      }),
    ),
    tts: v.optional(
      v.object({
        auto: v.optional(v.string()),
        provider: v.optional(v.string()),
        model: v.optional(v.string()),
        voice: v.optional(v.string()),
        persona: v.optional(v.string()),
      }),
    ),
    talk: v.optional(
      v.object({
        enabled: v.optional(v.boolean()),
        realtimeProvider: v.optional(v.string()),
        realtimeModel: v.optional(v.string()),
        voice: v.optional(v.string()),
        transport: v.optional(v.string()),
        speechLocale: v.optional(v.string()),
        silenceTimeoutMs: v.optional(v.number()),
        interruptOnSpeech: v.optional(v.boolean()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const meta = await ctx.db
      .query("integrationConfig")
      .withIndex("by_key", (q) => q.eq("key", INTEGRATION_CONFIG_KEY))
      .unique();
    const merge = <T extends object>(
      existing: T | undefined,
      incoming: T | undefined,
    ): T | undefined => (incoming ? { ...(existing ?? {}), ...incoming } : existing);

    const next = {
      key: INTEGRATION_CONFIG_KEY,
      langfuse: merge(meta?.langfuse, args.langfuse),
      opik: merge(meta?.opik, args.opik),
      tts: merge(meta?.tts, args.tts),
      talk: merge(meta?.talk, args.talk),
    };
    if (meta === null) {
      await ctx.db.insert("integrationConfig", next);
      return;
    }
    await ctx.db.patch(meta._id, next);
  },
});

// --- Per-user routing override ---------------------------------------------

export const setUserRouting = mutation({
  args: {
    profileId: v.id("profiles"),
    groupId: v.optional(v.union(v.id("groups"), v.null())),
    overrideInstance: v.optional(v.union(v.string(), v.null())),
    overrideAgentId: v.optional(v.union(v.string(), v.null())),
    canonical: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const target = await ctx.db.get(args.profileId);
    if (target === null) throw new Error("Not found: profile");
    const patch: Record<string, unknown> = {};
    if (args.groupId !== undefined)
      patch.groupId = args.groupId === null ? undefined : args.groupId;
    if (args.overrideInstance !== undefined)
      patch.overrideInstance =
        args.overrideInstance === null ? undefined : args.overrideInstance;
    if (args.overrideAgentId !== undefined)
      patch.overrideAgentId =
        args.overrideAgentId === null ? undefined : args.overrideAgentId;
    if (args.canonical !== undefined) patch.canonical = args.canonical;
    await ctx.db.patch(args.profileId, patch);
  },
});

// --- Per-user Settings tab permissions (per-tab RBAC grants) -----------------

// Grant a user the read-only permissions that open specific Settings tabs to a
// non-admin. The GRANTABLE whitelist is enforced HERE (server-side) — the real
// boundary; UI hiding is cosmetic. admin.manage and any sensitive/write perm are
// rejected, so a non-admin can never gain a sensitive-tab grant, even via a
// malformed or replayed call. `permissions` REPLACES the user's grant set.
export const setUserPermissions = mutation({
  args: { profileId: v.id("profiles"), permissions: v.array(v.string()) },
  handler: async (ctx, { profileId, permissions }) => {
    await requireAdmin(ctx);
    const invalid = permissions.filter((p) => !isGrantableUserPermission(p));
    if (invalid.length > 0) {
      throw new Error(`Permissions not grantable: ${invalid.join(", ")}`);
    }
    const target = await ctx.db.get(profileId);
    if (target === null) throw new Error("Not found: profile");
    await ctx.db.patch(profileId, {
      extraPermissions: [...new Set(permissions)],
    });
  },
});

// --- Groups (valves) --------------------------------------------------------

const modeValidator = v.union(v.literal("per-user"), v.literal("shared"));

export const listGroups = query({
  args: { filter: v.optional(filterValidator) },
  handler: async (ctx, { filter }) => {
    await requireAdmin(ctx);
    // listGroups returns the raw docs (no toView) — "view" == the returned
    // object, so the filter reads the doc's own fields (name/instanceName/mode).
    const groups = await ctx.db.query("groups").order("desc").take(200);
    return applyFilter(groups, filter, GROUPS_FILTER_CFG);
  },
});

export const createGroup = mutation({
  args: {
    name: v.string(),
    instanceName: v.string(),
    mode: modeValidator,
    sharedAgentId: v.optional(v.string()),
    description: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    if (args.mode === "shared" && !args.sharedAgentId) {
      throw new Error("A shared group requires sharedAgentId");
    }
    return await ctx.db.insert("groups", args);
  },
});

export const updateGroup = mutation({
  args: {
    groupId: v.id("groups"),
    name: v.optional(v.string()),
    instanceName: v.optional(v.string()),
    mode: v.optional(modeValidator),
    sharedAgentId: v.optional(v.union(v.string(), v.null())),
    description: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const group = await ctx.db.get(args.groupId);
    if (group === null) throw new Error("Not found: group");
    const mode = args.mode ?? group.mode;
    const sharedAgentId =
      args.sharedAgentId === null
        ? undefined
        : (args.sharedAgentId ?? group.sharedAgentId);
    if (mode === "shared" && !sharedAgentId) {
      throw new Error("A shared group requires sharedAgentId");
    }
    const patch: Record<string, unknown> = { mode, sharedAgentId };
    if (args.name !== undefined) patch.name = args.name;
    if (args.instanceName !== undefined) patch.instanceName = args.instanceName;
    if (args.description !== undefined)
      patch.description = args.description === null ? undefined : args.description;
    await ctx.db.patch(args.groupId, patch);
  },
});

export const deleteGroup = mutation({
  args: { groupId: v.id("groups") },
  handler: async (ctx, { groupId }) => {
    await requireAdmin(ctx);
    // Block deletion while members reference the group (avoid orphaned routing).
    const members = await ctx.db
      .query("profiles")
      .filter((q) => q.eq(q.field("groupId"), groupId))
      .take(1);
    if (members.length > 0) {
      throw new Error("Refused: group has members; reassign them first");
    }
    await ctx.db.delete(groupId);
  },
});

// --- Instances (non-secret metadata) ---------------------------------------

export const listInstances = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    return await ctx.db.query("instances").order("desc").take(200);
  },
});

export const upsertInstance = mutation({
  args: {
    instanceId: v.optional(v.id("instances")),
    name: v.string(),
    gatewayUrl: v.string(),
    displayName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    if (args.instanceId) {
      await ctx.db.patch(args.instanceId, {
        name: args.name,
        gatewayUrl: args.gatewayUrl,
        displayName: args.displayName,
      });
      return args.instanceId;
    }
    return await ctx.db.insert("instances", {
      name: args.name,
      gatewayUrl: args.gatewayUrl,
      displayName: args.displayName,
    });
  },
});

export const deleteInstance = mutation({
  args: { instanceId: v.id("instances") },
  handler: async (ctx, { instanceId }) => {
    await requireAdmin(ctx);
    await ctx.db.delete(instanceId);
  },
});
