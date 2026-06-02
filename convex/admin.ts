// Admin settings surface. EVERY function here requires the admin role
// (requireAdmin derives identity via ctx.auth — never an arg). Manages users
// (roles/approval), routing groups (valves), per-user overrides, and instance
// metadata. NO secrets are read or written (gateway tokens / device identities
// live only in the bridge env; these tables hold non-secret names).

import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { getProfile, requireAdmin, roleOf } from "./lib/access";

const roleValidator = v.union(
  v.literal("pending"),
  v.literal("user"),
  v.literal("admin"),
);

// --- Users ------------------------------------------------------------------

export const listUsers = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    // Bounded: take the most recent N profiles. (Admin user lists are small;
    // paginate later if a deployment grows large.)
    const profiles = await ctx.db.query("profiles").order("desc").take(500);
    return profiles.map((p) => ({
      _id: p._id,
      userId: p.userId,
      role: roleOf(p),
      email: p.email ?? null,
      name: p.name ?? null,
      groupId: p.groupId ?? null,
      overrideInstance: p.overrideInstance ?? null,
      overrideAgentId: p.overrideAgentId ?? null,
      canonical: p.canonical ?? null,
    }));
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

export const setRole = mutation({
  args: { profileId: v.id("profiles"), role: roleValidator },
  handler: async (ctx, { profileId, role }) => {
    await requireAdmin(ctx);
    const target = await ctx.db.get(profileId);
    if (target === null) throw new Error("Not found: profile");
    // Last-admin protection: never demote the only remaining admin (lockout).
    if (roleOf(target) === "admin" && role !== "admin") {
      if ((await adminCount(ctx)) <= 1) {
        throw new Error("Refused: cannot demote the last admin");
      }
    }
    await ctx.db.patch(profileId, { role });
  },
});

// Convenience: approve a pending user to "user".
export const approveUser = mutation({
  args: { profileId: v.id("profiles") },
  handler: async (ctx, { profileId }) => {
    await requireAdmin(ctx);
    const target = await ctx.db.get(profileId);
    if (target === null) throw new Error("Not found: profile");
    await ctx.db.patch(profileId, { role: "user" });
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

// --- Groups (valves) --------------------------------------------------------

const modeValidator = v.union(v.literal("per-user"), v.literal("shared"));

export const listGroups = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    return await ctx.db.query("groups").order("desc").take(200);
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
