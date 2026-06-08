/// <reference types="vite/client" />
//
// Multi-agent backbone invariants (red-team-critical):
//  - discovery is RESILIENT: a failed poll keeps last-good + lastOkAt; an agent
//    absent from a SUCCESSFUL poll flips presentInLastOk (deleted) but is NEVER
//    removed from the cache (B2 / blind-spot-1).
//  - assignAgent only accepts DISCOVERED + present agents (prod-bug fix / M1).
//  - exactly one default whenever >=1 userAgent (first→default, setDefault clears
//    the old, removeAgent re-elects — H2/H3).

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const A = (
  agentId: string,
  isDefaultOnInstance = false,
  displayName: string | null = null,
) => ({ agentId, displayName, emoji: null, model: "m", isDefaultOnInstance });

async function seedAdminAndTarget(t: ReturnType<typeof convexTest>) {
  const adminId = await t.run(async (ctx) => {
    const uid = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId: uid, role: "admin" });
    return uid;
  });
  const { profileId, userId } = await t.run(async (ctx) => {
    const uid = await ctx.db.insert("users", {});
    const pid = await ctx.db.insert("profiles", { userId: uid, role: "user" });
    return { profileId: pid, userId: uid };
  });
  return {
    as: t.withIdentity({ subject: `${adminId}|session` }),
    profileId,
    userId,
  };
}

// Filter in JS (convexTest's t.run ctx loses index types via ReturnType<...>).
const uaOf = async (t: ReturnType<typeof convexTest>, userId: string) => {
  const rows = await t.run((ctx) => ctx.db.query("userAgents").collect());
  return rows.filter((r) => r.userId === userId);
};

describe("discovery cache resilience (B2)", () => {
  test("successful poll inserts present agents; a later poll omitting one marks it deleted (not removed)", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.agents.applyDiscovery, {
      instanceName: "prod",
      agents: [A("olivier", true), A("pissey")],
    });
    let rows = await t.run((ctx) =>
      ctx.db
        .query("agents")
        .withIndex("by_instance", (q) => q.eq("instanceName", "prod"))
        .collect(),
    );
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.presentInLastOk)).toBe(true);

    // pissey deleted on the gateway -> omitted from the next SUCCESSFUL poll.
    await t.mutation(internal.agents.applyDiscovery, {
      instanceName: "prod",
      agents: [A("olivier", true)],
    });
    rows = await t.run((ctx) =>
      ctx.db
        .query("agents")
        .withIndex("by_instance", (q) => q.eq("instanceName", "prod"))
        .collect(),
    );
    expect(rows.length).toBe(2); // never removed
    expect(rows.find((r) => r.agentId === "pissey")!.presentInLastOk).toBe(false);
    expect(rows.find((r) => r.agentId === "olivier")!.presentInLastOk).toBe(true);
  });

  test("a FAILED poll preserves last-good rows + lastOkAt, flips lastPollOk", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.agents.applyDiscovery, {
      instanceName: "prod",
      agents: [A("olivier", true)],
    });
    await t.mutation(internal.agents.recordDiscoveryFailure, {
      instanceName: "prod",
      error: "unreachable",
    });
    const disc = await t.run((ctx) =>
      ctx.db
        .query("instanceDiscovery")
        .withIndex("by_instance", (q) => q.eq("instanceName", "prod"))
        .unique(),
    );
    expect(disc!.lastPollOk).toBe(false);
    expect(disc!.error).toBe("unreachable");
    expect(typeof disc!.lastOkAt).toBe("number"); // staleness window preserved
    const rows = await t.run((ctx) =>
      ctx.db
        .query("agents")
        .withIndex("by_instance", (q) => q.eq("instanceName", "prod"))
        .collect(),
    );
    expect(rows.length).toBe(1); // cache NOT emptied
    expect(rows[0].presentInLastOk).toBe(true); // presence NOT flipped on failure
  });

  test("empty discovery: allowEmpty marks ALL deleted (genuine); without it, presence is kept (shape-drift) — Codex P2", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.agents.applyDiscovery, {
      instanceName: "prod",
      agents: [A("olivier", true), A("pissey")],
    });
    const rowsOf = () =>
      t.run((ctx) =>
        ctx.db
          .query("agents")
          .withIndex("by_instance", (q) => q.eq("instanceName", "prod"))
          .collect(),
      );

    // Shape-drift / old-bridge empty (no allowEmpty) → presence PRESERVED (MAJOR 1).
    await t.mutation(internal.agents.applyDiscovery, { instanceName: "prod", agents: [] });
    let rows = await rowsOf();
    expect(rows.every((r) => r.presentInLastOk)).toBe(true);

    // GENUINELY empty gateway (allowEmpty) → every agent flipped deleted (Codex P2),
    // never removed.
    await t.mutation(internal.agents.applyDiscovery, {
      instanceName: "prod",
      agents: [],
      allowEmpty: true,
    });
    rows = await rowsOf();
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.presentInLastOk === false)).toBe(true);
  });
});

describe("assignAgent — discovered-only whitelist + first-is-default", () => {
  test("rejects a non-discovered agent (prod-bug fix)", async () => {
    const t = convexTest(schema, modules);
    const { as, profileId } = await seedAdminAndTarget(t);
    await t.mutation(internal.agents.applyDiscovery, {
      instanceName: "prod",
      agents: [A("olivier", true)],
    });
    await expect(
      as.mutation(api.agents.assignAgent, {
        profileId,
        instanceName: "prod",
        agentId: "ghost",
      }),
    ).rejects.toThrow(/not assignable/);
  });

  test("first assigned agent becomes default; second does not; idempotent", async () => {
    const t = convexTest(schema, modules);
    const { as, profileId, userId } = await seedAdminAndTarget(t);
    await t.mutation(internal.agents.applyDiscovery, {
      instanceName: "prod",
      agents: [A("olivier", true), A("pissey")],
    });
    await as.mutation(api.agents.assignAgent, {
      profileId,
      instanceName: "prod",
      agentId: "olivier",
    });
    let ua = await uaOf(t, userId);
    expect(ua.length).toBe(1);
    expect(ua[0].isDefault).toBe(true);

    await as.mutation(api.agents.assignAgent, {
      profileId,
      instanceName: "prod",
      agentId: "pissey",
    });
    ua = await uaOf(t, userId);
    expect(ua.length).toBe(2);
    expect(ua.filter((r) => r.isDefault).length).toBe(1);

    // idempotent re-assign — no duplicate row
    await as.mutation(api.agents.assignAgent, {
      profileId,
      instanceName: "prod",
      agentId: "olivier",
    });
    ua = await uaOf(t, userId);
    expect(ua.length).toBe(2);
  });
});

describe("setDefaultAgent / removeAgent — exactly-one-default (H2/H3)", () => {
  async function setup() {
    const t = convexTest(schema, modules);
    const { as, profileId, userId } = await seedAdminAndTarget(t);
    await t.mutation(internal.agents.applyDiscovery, {
      instanceName: "prod",
      agents: [A("olivier", true), A("pissey")],
    });
    for (const agentId of ["olivier", "pissey"]) {
      await as.mutation(api.agents.assignAgent, {
        profileId,
        instanceName: "prod",
        agentId,
      });
    }
    return { t, as, profileId, userId };
  }

  test("setDefault moves the default and clears the old one", async () => {
    const { t, as, profileId, userId } = await setup();
    await as.mutation(api.agents.setDefaultAgent, {
      profileId,
      instanceName: "prod",
      agentId: "pissey",
    });
    const ua = await uaOf(t, userId);
    expect(ua.filter((r) => r.isDefault).length).toBe(1);
    expect(ua.find((r) => r.agentId === "pissey")!.isDefault).toBe(true);
    expect(ua.find((r) => r.agentId === "olivier")!.isDefault).toBe(false);
  });

  test("removing the default re-elects another (never agents-but-no-default)", async () => {
    const { t, as, profileId, userId } = await setup();
    // olivier is the default (first). Remove it.
    await as.mutation(api.agents.removeAgent, {
      profileId,
      instanceName: "prod",
      agentId: "olivier",
    });
    const ua = await uaOf(t, userId);
    expect(ua.length).toBe(1);
    expect(ua[0].agentId).toBe("pissey");
    expect(ua[0].isDefault).toBe(true); // re-elected
  });

  test("removing a non-default leaves the default intact", async () => {
    const { t, as, profileId, userId } = await setup();
    await as.mutation(api.agents.removeAgent, {
      profileId,
      instanceName: "prod",
      agentId: "pissey",
    });
    const ua = await uaOf(t, userId);
    expect(ua.length).toBe(1);
    expect(ua[0].agentId).toBe("olivier");
    expect(ua[0].isDefault).toBe(true);
  });
});

describe("enrichUserAgents state priority (Codex P2 — deleted wins over stale)", () => {
  async function seedUserWithAgent(
    t: ReturnType<typeof convexTest>,
    opts: { present: boolean; lastPollOk: boolean | null },
  ) {
    const userId = await t.run(async (ctx) => {
      const uid = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", { userId: uid, role: "user", canonical: "alice" });
      await ctx.db.insert("userAgents", {
        userId: uid,
        instanceName: "prod",
        agentId: "pissey",
        isDefault: true,
        source: "manual",
        createdAt: 1,
      });
      await ctx.db.insert("agents", {
        instanceName: "prod",
        agentId: "pissey",
        source: "discovered",
        presentInLastOk: opts.present,
        firstSeenAt: 1,
        lastSeenAt: 1,
      });
      if (opts.lastPollOk !== null) {
        await ctx.db.insert("instanceDiscovery", {
          instanceName: "prod",
          lastPollAt: 1,
          lastPollOk: opts.lastPollOk,
          lastOkAt: 1,
        });
      }
      return uid;
    });
    return t.withIdentity({ subject: `${userId}|session` });
  }
  const stateOf = async (as: Awaited<ReturnType<typeof seedUserWithAgent>>) => {
    const agents = await as.query(api.agents.listMyAgents, {});
    return agents.find((a) => a.agentId === "pissey")!.state;
  };

  test("known-deleted stays 'deleted' even when the LATEST poll FAILED (blip must not re-offer it)", async () => {
    const t = convexTest(schema, modules);
    const as = await seedUserWithAgent(t, { present: false, lastPollOk: false });
    expect(await stateOf(as)).toBe("deleted");
  });

  test("present agent during a failed poll is 'stale' (not deleted)", async () => {
    const t = convexTest(schema, modules);
    const as = await seedUserWithAgent(t, { present: true, lastPollOk: false });
    expect(await stateOf(as)).toBe("stale");
  });

  test("present agent after a successful poll is 'ok'", async () => {
    const t = convexTest(schema, modules);
    const as = await seedUserWithAgent(t, { present: true, lastPollOk: true });
    expect(await stateOf(as)).toBe("ok");
  });
});

describe("deleteInstance cascade (Codex P2 — no orphan grants)", () => {
  // Filter in JS — a `t: ReturnType<typeof convexTest>` PARAMETER loses the
  // inferred data model, so `withIndex("by_instance")` fails `npx convex
  // typecheck` (Codex P1). Same workaround as `uaOf` above.
  const agentsOf = (t: ReturnType<typeof convexTest>, name: string) =>
    t.run(async (ctx) => {
      const rows = await ctx.db.query("agents").collect();
      return rows.filter((r) => r.instanceName === name);
    });

  test("removes the instance's agents/discovery/userAgents and re-elects a default", async () => {
    const t = convexTest(schema, modules);
    const { as, profileId, userId } = await seedAdminAndTarget(t);
    await t.mutation(internal.agents.applyDiscovery, {
      instanceName: "prod",
      agents: [A("olivier", true)],
    });
    await t.mutation(internal.agents.applyDiscovery, {
      instanceName: "other",
      agents: [A("bob", true)],
    });
    const prodId = await t.run((ctx) =>
      ctx.db.insert("instances", { name: "prod", gatewayUrl: "ws://p", kind: "openclaw" }),
    );
    await t.run((ctx) =>
      ctx.db.insert("instances", { name: "other", gatewayUrl: "ws://o", kind: "openclaw" }),
    );
    await as.mutation(api.agents.assignAgent, {
      profileId,
      instanceName: "prod",
      agentId: "olivier",
    }); // default (first)
    await as.mutation(api.agents.assignAgent, {
      profileId,
      instanceName: "other",
      agentId: "bob",
    }); // not default

    await as.mutation(api.admin.deleteInstance, { instanceId: prodId });

    expect((await agentsOf(t, "prod")).length).toBe(0);
    const prodDisc = await t.run((ctx) =>
      ctx.db
        .query("instanceDiscovery")
        .withIndex("by_instance", (q) => q.eq("instanceName", "prod"))
        .collect(),
    );
    expect(prodDisc.length).toBe(0);
    const ua = await uaOf(t, userId);
    expect(ua.length).toBe(1); // prod grant gone
    expect(ua[0].instanceName).toBe("other");
    expect(ua[0].isDefault).toBe(true); // re-elected (prod/olivier was the default)
    expect((await agentsOf(t, "other")).length).toBe(1); // other untouched
  });

  test("does NOT orphan-clean when a DUPLICATE instance row still serves the name", async () => {
    const t = convexTest(schema, modules);
    const { as, profileId, userId } = await seedAdminAndTarget(t);
    await t.mutation(internal.agents.applyDiscovery, {
      instanceName: "prod",
      agents: [A("olivier", true)],
    });
    const dupId = await t.run((ctx) =>
      ctx.db.insert("instances", { name: "prod", gatewayUrl: "ws://a", kind: "openclaw" }),
    );
    await t.run((ctx) =>
      ctx.db.insert("instances", { name: "prod", gatewayUrl: "ws://b", kind: "openclaw" }),
    ); // duplicate name
    await as.mutation(api.agents.assignAgent, {
      profileId,
      instanceName: "prod",
      agentId: "olivier",
    });
    await as.mutation(api.admin.deleteInstance, { instanceId: dupId });
    expect((await uaOf(t, userId)).length).toBe(1); // grant kept
    expect((await agentsOf(t, "prod")).length).toBe(1); // agents kept
  });
});
