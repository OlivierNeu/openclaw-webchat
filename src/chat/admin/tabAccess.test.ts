import { describe, expect, test } from "vitest";
import {
  TABS,
  TAB_PERMISSION,
  GRANTABLE_TABS,
  visibleTabs,
  pathForTab,
  tabFromPathname,
} from "../AdminSettings";
import {
  PERMISSIONS,
  GRANTABLE_USER_PERMISSIONS,
} from "../../../convex/lib/rbac";

// The per-tab RBAC map is the UX mirror of the server's permission gates. These
// tests pin the two together so the nav/landing/grant-editor can NEVER drift
// from what the Convex queries actually enforce.

describe("TAB_PERMISSION", () => {
  test("is total over TABS (one permission per tab)", () => {
    for (const t of TABS) {
      expect(typeof TAB_PERMISSION[t]).toBe("string");
    }
    expect(Object.keys(TAB_PERMISSION).sort()).toEqual([...TABS].sort());
  });

  test("every gating permission is a REAL permission the server knows", () => {
    const known = new Set<string>(Object.values(PERMISSIONS));
    for (const t of TABS) {
      expect(known.has(TAB_PERMISSION[t])).toBe(true);
    }
  });
});

describe("GRANTABLE_TABS ↔ server whitelist (lockstep)", () => {
  test("the grantable tabs map exactly onto GRANTABLE_USER_PERMISSIONS", () => {
    const fromTabs = new Set(GRANTABLE_TABS.map((t) => TAB_PERMISSION[t]));
    const fromServer = new Set<string>(GRANTABLE_USER_PERMISSIONS);
    expect([...fromTabs].sort()).toEqual([...fromServer].sort());
  });

  test("no grantable tab is gated by admin.manage", () => {
    for (const t of GRANTABLE_TABS) {
      expect(TAB_PERMISSION[t]).not.toBe(PERMISSIONS.ADMIN_MANAGE);
    }
  });
});

describe("visibleTabs", () => {
  test("a full-permission holder (admin) sees every tab, in TABS order", () => {
    const all = Object.values(PERMISSIONS);
    expect(visibleTabs(all)).toEqual([...TABS]);
  });

  test("a holder of two read perms sees exactly those tabs, in TABS order", () => {
    // bridge (index 3) precedes traces (index 6) in TABS → nav order, not grant
    // order.
    expect(visibleTabs(["traces.read", "bridge.read"])).toEqual([
      "bridge",
      "traces",
    ]);
  });

  test("a plain user (chats.read only) sees no settings tab", () => {
    expect(visibleTabs(["chats.read"])).toEqual([]);
    expect(visibleTabs([])).toEqual([]);
  });
});

describe("pathForTab / tabFromPathname (round-trip)", () => {
  test("pathForTab builds /settings/<tab> and tabFromPathname reverses it", () => {
    for (const t of TABS) {
      expect(pathForTab(t)).toBe(`/settings/${t}`);
      expect(tabFromPathname(pathForTab(t))).toBe(t);
    }
  });

  test("non-tab pathnames resolve to undefined", () => {
    expect(tabFromPathname("/settings")).toBeUndefined();
    expect(tabFromPathname("/settings/bogus")).toBeUndefined();
    expect(tabFromPathname("/chat/abc")).toBeUndefined();
    expect(tabFromPathname("/")).toBeUndefined();
  });
});
