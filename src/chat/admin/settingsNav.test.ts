import { describe, expect, test } from "vitest";
import { mergeOrder } from "./SettingsNav";
import { TABS } from "../AdminSettings";

// mergeOrder is the load-bearing merge for the per-user tab order: saved (valid,
// de-duped) keys first, then any tab NOT yet saved (new tabs), unknown/stale keys
// dropped. It must always return exactly the full TABS set, in a stable order.

describe("mergeOrder", () => {
  test("no saved order -> the default code order, unchanged", () => {
    expect(mergeOrder(null)).toEqual([...TABS]);
    expect(mergeOrder(undefined)).toEqual([...TABS]);
    expect(mergeOrder([])).toEqual([...TABS]);
  });

  test("a saved order is honored, with NEW (unsaved) tabs appended after", () => {
    // Pretend only two tabs were ever saved (in reverse): they lead, the rest
    // follow in code order.
    const out = mergeOrder(["bridge", "users"]);
    expect(out.slice(0, 2)).toEqual(["bridge", "users"]);
    // every other tab still present, exactly once
    expect(new Set(out)).toEqual(new Set(TABS));
    expect(out).toHaveLength(TABS.length);
  });

  test("unknown / stale keys are dropped; duplicates collapse", () => {
    const out = mergeOrder(["users", "ghost-tab", "users", "bridge"]);
    expect(out).not.toContain("ghost-tab");
    expect(out.filter((t) => t === "users")).toHaveLength(1);
    expect(new Set(out)).toEqual(new Set(TABS)); // still the full set
  });

  test("a fully-specified saved order round-trips exactly", () => {
    const reversed = [...TABS].reverse();
    expect(mergeOrder(reversed)).toEqual(reversed);
  });
});
