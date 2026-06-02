// Current-user surface: the FIRST thing the authenticated client calls.
//
// `bootstrap` is the ONLY public mutation a "pending" user is allowed to call:
// it provisions the profile (via the single role-writer `ensureProfile`, which
// also runs first-admin bootstrap) so the user appears in the admin's approval
// list. Every other public function requires an ACTIVE role and would reject a
// pending user — without this entry point a pending user would be invisible to
// admins and could never be approved.
//
// `getMe` is a reactive read the UI subscribes to: it drives BOTH the surface
// choice (pending / chat / admin) AND the resolved theme. Theme preference is
// identity-level (a pending user still controls it), so `setThemeMode` is gated
// on requireUserId, not requireActive.

import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { ensureProfile, getProfile, requireUserId, roleOf } from "./lib/access";

const APP_META_KEY = "singleton";

type ThemeMode = "light" | "dark" | "system";

async function readAppMeta(ctx: QueryCtx | MutationCtx) {
  return await ctx.db
    .query("appMeta")
    .withIndex("by_key", (q) => q.eq("key", APP_META_KEY))
    .unique();
}

// Resolve the effective theme mode: user pref -> admin default -> "system".
// (Mode-only fallback chain; there is no "system" palette equivalent.)
function resolveThemeMode(
  userMode: ThemeMode | undefined,
  adminDefault: ThemeMode | undefined,
): ThemeMode {
  return userMode ?? adminDefault ?? "system";
}

export const bootstrap = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await ensureProfile(ctx);
    const profile = await getProfile(ctx, userId);
    return { role: roleOf(profile) };
  },
});

export const getMe = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    const profile = await getProfile(ctx, userId);
    const meta = await readAppMeta(ctx);
    const adminDefaultMode = meta?.defaultThemeMode as ThemeMode | undefined;
    const userMode = profile?.themeMode as ThemeMode | undefined;
    return {
      userId,
      role: roleOf(profile),
      email: profile?.email ?? null,
      name: profile?.name ?? null,
      hasProfile: profile !== null,
      // Theme: the user's own pref (or null) + the resolved effective value the
      // client should apply + the admin default (so the Theme tab can show it).
      themeMode: userMode ?? null,
      resolvedThemeMode: resolveThemeMode(userMode, adminDefaultMode),
      defaultThemeMode: adminDefaultMode ?? null,
    };
  },
});

// Set the calling user's theme preference. Identity-level: requireUserId (NOT
// requireActive) so a pending user on the waiting screen can still theme the UI.
// Passing null clears the pref (revert to the admin default).
export const setThemeMode = mutation({
  args: {
    mode: v.union(
      v.literal("light"),
      v.literal("dark"),
      v.literal("system"),
      v.null(),
    ),
  },
  handler: async (ctx, { mode }) => {
    const userId = await requireUserId(ctx);
    const profile = await getProfile(ctx, userId);
    if (profile === null) {
      // No profile yet (pre-bootstrap). Create a minimal pending profile that
      // only carries the theme pref; ensureProfile will fill the rest later.
      await ctx.db.insert("profiles", {
        userId,
        role: "pending",
        themeMode: mode ?? undefined,
      });
      return;
    }
    await ctx.db.patch(profile._id, { themeMode: mode ?? undefined });
  },
});
