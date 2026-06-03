/// <reference types="vite/client" />
//
// Deterministic unit test for the observability/RBAC spine (increment 1).
//
// This test exercises the DETERMINISTIC core only — it does NOT depend on
// @convex-dev/auth session simulation. The key-authed HTTP path (curl) is
// live-verified separately by the lead. Here we:
//   1. seed the built-in roles,
//   2. insert a service account + an apiKey whose hashedKey is the SHA-256 of a
//      known plaintext,
//   3. assert internal.apiKeys.findByHash resolves it (and carries the expanded
//      permission set), and
//   4. assert the pure RBAC engine grants/denies the right permissions.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import { hashKey } from "./lib/apikeys";
import {
  permissionsForRoleKey,
  roleHasPermission,
  seedBuiltinRoles,
  PERMISSIONS,
} from "./lib/rbac";

// Discover function modules for convex-test (required).
const modules = import.meta.glob("./**/*.ts");

describe("observability spine", () => {
  test("findByHash resolves a seeded key with its permission set", async () => {
    const t = convexTest(schema, modules);

    const plaintext = "oc_live_test";
    const hashedKey = await hashKey(plaintext);

    // Seed roles + a service account + an API key entirely in db context.
    const { keyId, serviceAccountId } = await t.run(async (ctx) => {
      await seedBuiltinRoles(ctx);

      // A user row to satisfy createdByUserId (no auth needed for the insert).
      const userId = await ctx.db.insert("users", {});

      const serviceAccountId = await ctx.db.insert("serviceAccounts", {
        name: "obs-test",
        roleKey: "observer",
        disabled: false,
        createdByUserId: userId,
      });

      const keyId = await ctx.db.insert("apiKeys", {
        serviceAccountId,
        hashedKey,
        prefix: "oc_live_test",
        lastFour: "test",
        disabled: false,
        createdAt: Date.now(),
      });

      return { keyId, serviceAccountId };
    });

    // The internal verification query resolves the key by hash and enriches it
    // with the service account + expanded permission set.
    const resolved = await t.query(internal.apiKeys.findByHash, {
      hash: hashedKey,
    });
    expect(resolved).not.toBeNull();
    expect(resolved!.key._id).toEqual(keyId);
    expect(resolved!.serviceAccount._id).toEqual(serviceAccountId);
    expect(resolved!.roleKey).toEqual("observer");
    // observer carries traces.read but NOT admin.manage.
    expect(resolved!.permissions).toContain(PERMISSIONS.TRACES_READ);
    expect(resolved!.permissions).not.toContain(PERMISSIONS.ADMIN_MANAGE);

    // A non-existent hash resolves to null.
    const missing = await t.query(internal.apiKeys.findByHash, {
      hash: "deadbeef".repeat(8),
    });
    expect(missing).toBeNull();
  });

  test("rbac engine grants/denies per role", async () => {
    const t = convexTest(schema, modules);

    await t.run(async (ctx) => {
      await seedBuiltinRoles(ctx);

      const observerPerms = await permissionsForRoleKey(ctx, "observer");
      expect(roleHasPermission(observerPerms, PERMISSIONS.TRACES_READ)).toBe(
        true,
      );
      expect(roleHasPermission(observerPerms, PERMISSIONS.ADMIN_MANAGE)).toBe(
        false,
      );

      // admin is the wildcard superset -> every permission.
      const adminPerms = await permissionsForRoleKey(ctx, "admin");
      expect(roleHasPermission(adminPerms, PERMISSIONS.ADMIN_MANAGE)).toBe(true);
      expect(roleHasPermission(adminPerms, PERMISSIONS.TRACES_READ)).toBe(true);

      // unknown role -> empty set -> no permissions (least privilege).
      const unknownPerms = await permissionsForRoleKey(ctx, "nope");
      expect(roleHasPermission(unknownPerms, PERMISSIONS.TRACES_READ)).toBe(
        false,
      );
    });
  });
});
