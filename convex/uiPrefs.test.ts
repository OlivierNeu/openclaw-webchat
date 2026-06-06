/// <reference types="vite/client" />
//
// UI preferences module — resolver + setUiPref gate.
//
// The discriminating property (what makes the gate "gated" and not "deleted on
// disable"): disabling a system feature hides it at READ time while PRESERVING
// the user's stored override, so re-enabling restores their choice. Plus: the
// server-side reject in setUiPref is the real enforcement (greying is cosmetic).

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { resolveUiPrefs } from "./lib/uiPrefs";

const modules = import.meta.glob("./**/*.ts");

describe("resolveUiPrefs", () => {
  test("resolution order: user override > admin default > code default", () => {
    // code default (showSource = true)
    expect(resolveUiPrefs(undefined, undefined, undefined).effective.showSource).toBe(true);
    // admin default overrides code default
    expect(
      resolveUiPrefs(undefined, { showSource: false }, undefined).effective.showSource,
    ).toBe(false);
    // user override beats admin default
    expect(
      resolveUiPrefs({ showSource: true }, { showSource: false }, undefined).effective
        .showSource,
    ).toBe(true);
  });

  test("no user override -> the admin default surfaces (pins the legacy-shadow bug)", () => {
    // The exact reported failure: with an EMPTY user override, the admin default
    // must apply (a former legacy field must NOT shadow it).
    expect(resolveUiPrefs({}, { showTools: false }, undefined).effective.showTools).toBe(
      false,
    );
    expect(resolveUiPrefs({}, { showTools: true }, undefined).effective.showTools).toBe(
      true,
    );
  });

  test("system gate at READ time: disabling hides but preserves the override", () => {
    const override = { voiceInput: true };
    // enabled + user true -> effective true, not locked
    let r = resolveUiPrefs(override, undefined, { voiceInput: true });
    expect(r.effective.voiceInput).toBe(true);
    expect(r.locked.voiceInput).toBe(false);

    // admin DISABLES the system -> effective false + locked, override UNCHANGED
    r = resolveUiPrefs(override, undefined, { voiceInput: false });
    expect(r.effective.voiceInput).toBe(false);
    expect(r.locked.voiceInput).toBe(true);
    expect(r.userOverrides.voiceInput).toBe(true); // survives (not deleted)

    // re-enable -> the user's choice returns
    r = resolveUiPrefs(override, undefined, { voiceInput: true });
    expect(r.effective.voiceInput).toBe(true);
  });

  test("a gated feature defaults locked + off when the system is unset", () => {
    const r = resolveUiPrefs(undefined, undefined, undefined);
    expect(r.locked.voiceInput).toBe(true);
    expect(r.effective.voiceInput).toBe(false);
  });
});

async function seedUser(t: ReturnType<typeof convexTest>) {
  const userId = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId, role: "user" });
    return userId;
  });
  return { userId, as: t.withIdentity({ subject: `${userId}|session` }) };
}

describe("me.setUiPref (single write path + server gate)", () => {
  test("rejects enabling a system-gated feature until the admin enables it", async () => {
    const t = convexTest(schema, modules);
    const { as } = await seedUser(t);

    // voiceInput is gated and not enabled -> the SERVER rejects it.
    await expect(
      as.mutation(api.me.setUiPref, { key: "voiceInput", value: true }),
    ).rejects.toThrow(/enabled/i);

    // a non-gated pref writes fine
    await as.mutation(api.me.setUiPref, { key: "showSource", value: false });

    // admin enables the system feature
    await t.run(async (ctx) => {
      const meta = await ctx.db
        .query("appMeta")
        .withIndex("by_key", (q) => q.eq("key", "singleton"))
        .unique();
      if (meta) {
        await ctx.db.patch(meta._id, { featuresEnabled: { voiceInput: true } });
      } else {
        await ctx.db.insert("appMeta", {
          key: "singleton",
          adminAssigned: true,
          featuresEnabled: { voiceInput: true },
        });
      }
    });

    // now the user can turn it on
    await as.mutation(api.me.setUiPref, { key: "voiceInput", value: true });

    // unknown keys are rejected
    await expect(
      as.mutation(api.me.setUiPref, { key: "nope", value: true }),
    ).rejects.toThrow(/unknown/i);

    const me = await as.query(api.me.getMe, {});
    expect(me.ui.effective.showSource).toBe(false);
    expect(me.ui.effective.voiceInput).toBe(true);
    expect(me.ui.userOverrides.showSource).toBe(false);
  });
});
