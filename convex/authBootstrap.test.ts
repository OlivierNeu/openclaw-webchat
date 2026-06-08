/// <reference types="vite/client" />
//
// Regression: the REAL OAuth bootstrap path on self-hosted.
//
// The production bug (NAS deploy 2026-06-07): @convex-dev/auth's JWT does NOT
// carry an `email` claim, so `ctx.auth.getUserIdentity().email` is undefined on a
// real OAuth session. `ensureProfile` used to gate on that and threw
// "Forbidden: identity has no email" with anon OFF → the bootstrap mutation
// (transactional) rolled back → NO profile, NO appMeta → every real user was
// stuck "pending" forever. The pre-existing tests never caught it: they seed
// `users {}` (no email) and pre-insert the profile directly, so they never run
// the ensureProfile email gate on a real OAuth identity.
//
// Fix: ensureProfile resolves the email from the `users` ROW (written by the
// provider profile()), not only from the JWT. These tests pin that, with anon
// OFF (the production posture).

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

describe("bootstrap resolves the email from the users row (JWT has no email claim)", () => {
  let prevAnon: string | undefined;
  let prevDomains: string | undefined;
  beforeEach(() => {
    prevAnon = process.env.OPENCLAW_ENABLE_ANON_AUTH;
    prevDomains = process.env.AUTH_ALLOWED_EMAIL_DOMAINS;
    delete process.env.OPENCLAW_ENABLE_ANON_AUTH; // anon OFF = production posture
    process.env.AUTH_ALLOWED_EMAIL_DOMAINS = "lacneu.com,ataraxis-coaching.com";
  });
  afterEach(() => {
    if (prevAnon === undefined) delete process.env.OPENCLAW_ENABLE_ANON_AUTH;
    else process.env.OPENCLAW_ENABLE_ANON_AUTH = prevAnon;
    if (prevDomains === undefined) delete process.env.AUTH_ALLOWED_EMAIL_DOMAINS;
    else process.env.AUTH_ALLOWED_EMAIL_DOMAINS = prevDomains;
  });

  test("identity has NO email + users.email in an allowed domain → first user becomes admin", async () => {
    const t = convexTest(schema, modules);
    // A real OAuth users row carries the verified email; the JWT identity does NOT.
    const userId = await t.run(async (ctx) =>
      ctx.db.insert("users", { email: "olivier@lacneu.com", name: "Olivier Neu" }),
    );
    const as = t.withIdentity({ subject: `${userId}|session` }); // no email claim

    const res = await as.mutation(api.me.bootstrap, {});
    expect(res.role).toBe("admin"); // first ever user → admin (no "no email" throw)

    await t.run(async (ctx) => {
      const profile = await ctx.db
        .query("profiles")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .unique();
      expect(profile?.role).toBe("admin");
      expect(profile?.email).toBe("olivier@lacneu.com");
      const meta = await ctx.db.query("appMeta").first();
      expect(meta?.adminAssigned).toBe(true);
    });
  });

  test("identity has NO email + users.email in a DISALLOWED domain → rejected", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) =>
      ctx.db.insert("users", { email: "intrus@evil.com" }),
    );
    const as = t.withIdentity({ subject: `${userId}|session` });
    await expect(as.mutation(api.me.bootstrap, {})).rejects.toThrow(
      /domain not allowed/,
    );
  });

  test("anon ON + no email anywhere → still allowed (dev Anonymous provider)", async () => {
    process.env.OPENCLAW_ENABLE_ANON_AUTH = "1";
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    const as = t.withIdentity({ subject: `${userId}|session` });
    const res = await as.mutation(api.me.bootstrap, {});
    expect(res.role).toBe("admin"); // first user, no-email exempt when anon on
  });

  test("anon ON: a NON-bootstrap sign-in is auto-approved as active 'user' (dev multi-user)", async () => {
    process.env.OPENCLAW_ENABLE_ANON_AUTH = "1";
    const t = convexTest(schema, modules);
    // First user claims admin (bootstrap).
    const firstId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    const first = await t
      .withIdentity({ subject: `${firstId}|session` })
      .mutation(api.me.bootstrap, {});
    expect(first.role).toBe("admin");
    // A SECOND dev identity → active "user" (NOT pending) so it's immediately
    // usable for live multi-user testing.
    const secondId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    const second = await t
      .withIdentity({ subject: `${secondId}|session` })
      .mutation(api.me.bootstrap, {});
    expect(second.role).toBe("user");
  });

  test("anon OFF (production posture): a NON-bootstrap sign-in is 'pending'", async () => {
    delete process.env.OPENCLAW_ENABLE_ANON_AUTH;
    const t = convexTest(schema, modules);
    const firstId = await t.run(async (ctx) =>
      ctx.db.insert("users", { email: "admin@lacneu.com" }),
    );
    const first = await t
      .withIdentity({ subject: `${firstId}|session` })
      .mutation(api.me.bootstrap, {});
    expect(first.role).toBe("admin");
    const secondId = await t.run(async (ctx) =>
      ctx.db.insert("users", { email: "second@lacneu.com" }),
    );
    const second = await t
      .withIdentity({ subject: `${secondId}|session` })
      .mutation(api.me.bootstrap, {});
    expect(second.role).toBe("pending"); // prod: approval required
  });
});
