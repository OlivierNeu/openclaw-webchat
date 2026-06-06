/// <reference types="vite/client" />
//
// Email-domain auth allowlist. Pins BOTH the pure helper AND the authoritative
// gate in ensureProfile (the part that profile() — which only runs in the live
// Google OAuth flow — cannot be tested locally). The disallowed path is the one
// that matters: a bad-domain OAuth identity must NOT get a profile/role.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { emailDomainAllowed, emailVerifiedTruthy } from "./lib/authDomains";

const modules = import.meta.glob("./**/*.ts");

describe("emailDomainAllowed (default lacneu.com / ataraxis-coaching.com)", () => {
  test("allows the operator domains, case-insensitively", () => {
    expect(emailDomainAllowed("alice@lacneu.com")).toBe(true);
    expect(emailDomainAllowed("bob@ataraxis-coaching.com")).toBe(true);
    expect(emailDomainAllowed("Alice@Lacneu.COM")).toBe(true);
  });
  test("rejects look-alike + substring attacks (exact post-@ match only)", () => {
    expect(emailDomainAllowed("x@evil-lacneu.com")).toBe(false);
    expect(emailDomainAllowed("x@lacneu.com.evil.com")).toBe(false);
    expect(emailDomainAllowed("x@notlacneu.com")).toBe(false);
    expect(emailDomainAllowed("lacneu.com@gmail.com")).toBe(false);
  });
  test("rejects empty / malformed / missing", () => {
    expect(emailDomainAllowed(undefined)).toBe(false);
    expect(emailDomainAllowed(null)).toBe(false);
    expect(emailDomainAllowed("")).toBe(false);
    expect(emailDomainAllowed("no-at-sign")).toBe(false);
    expect(emailDomainAllowed("x@")).toBe(false);
  });
  test("env override (set + restore)", () => {
    const prev = process.env.AUTH_ALLOWED_EMAIL_DOMAINS;
    try {
      process.env.AUTH_ALLOWED_EMAIL_DOMAINS = " Example.com , foo.io ";
      expect(emailDomainAllowed("a@example.com")).toBe(true); // trimmed + lc
      expect(emailDomainAllowed("a@foo.io")).toBe(true);
      expect(emailDomainAllowed("a@lacneu.com")).toBe(false); // default no longer applies
    } finally {
      if (prev === undefined) delete process.env.AUTH_ALLOWED_EMAIL_DOMAINS;
      else process.env.AUTH_ALLOWED_EMAIL_DOMAINS = prev;
    }
  });
  test("emailVerifiedTruthy accepts bool or string, rejects anything else", () => {
    expect(emailVerifiedTruthy(true)).toBe(true);
    expect(emailVerifiedTruthy("true")).toBe(true);
    expect(emailVerifiedTruthy(false)).toBe(false);
    expect(emailVerifiedTruthy("false")).toBe(false);
    expect(emailVerifiedTruthy(undefined)).toBe(false);
  });
});

/** A user row that exists in auth but has NO profile yet, + an identity-bound
 *  client carrying the given email (undefined = anonymous-style, no email). */
async function authedNoProfile(
  t: ReturnType<typeof convexTest>,
  email: string | undefined,
) {
  const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
  const identity: { subject: string; email?: string } = {
    subject: `${userId}|session`,
  };
  if (email !== undefined) identity.email = email;
  return { userId, as: t.withIdentity(identity) };
}

async function profileOf(t: ReturnType<typeof convexTest>, userId: string) {
  return await t.run(async (ctx) =>
    ctx.db
      .query("profiles")
      .filter((q) => q.eq(q.field("userId"), userId))
      .first(),
  );
}

describe("ensureProfile email-domain gate (authoritative, defense-in-depth)", () => {
  test("allowed-domain OAuth identity → profile provisioned", async () => {
    const t = convexTest(schema, modules);
    const { userId, as } = await authedNoProfile(t, "alice@lacneu.com");
    await as.mutation(api.me.bootstrap, {});
    const p = await profileOf(t, userId);
    expect(p).not.toBeNull();
    expect(p!.email).toBe("alice@lacneu.com");
  });

  test("DISALLOWED-domain OAuth identity → rejected, NO profile/role created", async () => {
    const t = convexTest(schema, modules);
    const { userId, as } = await authedNoProfile(t, "mallory@gmail.com");
    await expect(as.mutation(api.me.bootstrap, {})).rejects.toThrow(/domain/i);
    expect(await profileOf(t, userId)).toBeNull(); // never provisioned
  });

  test("anonymous identity (no email) is EXEMPT (dev) → profile provisioned", async () => {
    const t = convexTest(schema, modules);
    const { userId, as } = await authedNoProfile(t, undefined);
    await as.mutation(api.me.bootstrap, {});
    expect(await profileOf(t, userId)).not.toBeNull();
  });
});
