// DEV-ONLY utilities. Every function here refuses to run unless the deployment
// has OPENCLAW_ENABLE_ANON_AUTH=1 (the same flag that enables the dev Anonymous
// auth provider). Never enabled in production.

import { v } from "convex/values";
import { action, internalMutation, mutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { generateApiKey, hashKey } from "./lib/apikeys";
import { seedBuiltinRoles } from "./lib/rbac";

function assertDev() {
  if (process.env.OPENCLAW_ENABLE_ANON_AUTH !== "1") {
    throw new Error("dev.* is disabled (OPENCLAW_ENABLE_ANON_AUTH != 1)");
  }
}

// Wipe app data (NOT the @convex-dev/auth tables, except we clear profiles so
// role bootstrap restarts cleanly). Used to reset local state between manual
// tests so the next sign-in deterministically becomes the bootstrap admin.
// Promote a profile to admin by its canonical (dev convenience for testing the
// admin UI when multiple stale anon sessions raced for the bootstrap admin).
export const makeAdmin = mutation({
  args: { canonical: v.string() },
  handler: async (ctx, { canonical }) => {
    assertDev();
    const all = await ctx.db.query("profiles").take(500);
    const match = all.find((p) => p.canonical === canonical);
    if (!match) return { ok: false, reason: "no profile with that canonical" };
    await ctx.db.patch(match._id, { role: "admin" });
    return { ok: true, profileId: match._id };
  },
});

// Seed a chat with a realistic user turn + a long assistant turn, so the chat
// rendering (width, contrast, bubbles) can be exercised without a live bridge.
// Seeds for the first admin profile (the manual-test account).
export const seedChat = mutation({
  args: { canonical: v.optional(v.string()) },
  handler: async (ctx, { canonical }) => {
    assertDev();
    const profiles = await ctx.db.query("profiles").take(500);
    const owner = canonical
      ? profiles.find((p) => p.canonical === canonical)
      : (profiles.find((p) => p.role === "admin") ?? profiles[0]);
    if (!owner) return { ok: false, reason: "no profile" };
    const userId = owner.userId;
    const now = Date.now();

    const chatId = await ctx.db.insert("chats", {
      userId,
      title: "Aperçu du rendu",
      archived: false,
      sortKey: -1000,
      updatedAt: now,
    });

    await ctx.db.insert("messages", {
      chatId,
      userId,
      role: "user",
      status: "complete",
      text:
        "En faite, je souhaiterais que dans mon one drive tu y dépose le fichier pdf que tu modifi, dit moi ou il se trouve et dit moi a chaque fois que tu le modifi",
      updatedAt: now,
    });

    await ctx.db.insert("messages", {
      chatId,
      userId,
      role: "assistant",
      status: "complete",
      text: [
        "Tu as raison : c'était **Google Drive**, pas OneDrive. J'ai corrigé et je viens de l'y déposer.",
        "",
        "**Emplacement Google Drive :**",
        "",
        "- Dossier : `OpenClaw/Hindsight`",
        "- Fichier : `HINDSIGHT-GUIDE.pdf`",
        "- Lien : [drive.google.com/file/d/1cM8…](https://drive.google.com/file/d/1cM8dJuLJxm4dgBvZaBopvfSPlsAuPB07/view)",
        "",
        "| Détail | Valeur |",
        "| --- | --- |",
        "| Compte | `olivier@lacneu.com` |",
        "| Taille | 542 235 octets |",
        "",
        "À partir de maintenant, à chaque modification du PDF je mettrai à jour **ce même fichier Drive** avec `--replace` :",
        "",
        "```bash",
        "openclaw drive upload \\",
        "  --replace HINDSIGHT-GUIDE.pdf \\",
        "  --folder OpenClaw/Hindsight",
        "```",
        "",
        "Ceci est une réponse volontairement longue et riche pour vérifier le rendu markdown (gras, `code`, listes, lien, tableau, bloc de code) ainsi que la largeur et le contraste, en thème clair comme en thème sombre.",
      ].join("\n"),
      updatedAt: now,
    });

    return { ok: true, chatId };
  },
});

// --- Observability spine: dev-gated service account + API key minting --------
//
// LIVE-VERIFY HELPER. The real mint path (apiKeys.mintApiKey) is an action that
// requires admin auth via ctx.auth, which a bare `npx convex run` cannot supply.
// This dev action mirrors that path WITHOUT requireAdmin (gated behind the dev
// flag) so the lead can mint a key from the CLI to exercise /api/v1/traces.
//
// Mirrors the action/mutation crypto split (D3): the action generates+hashes
// (Web Crypto, non-deterministic) then persists via an internalMutation.

/**
 * Internal: create-or-reuse a service account by name and persist a (already
 * hashed) API key. Also seeds built-in roles so the roleKey resolves at auth
 * time. Dev-gated. Returns the ids.
 */
export const seedApiKeyRecord = internalMutation({
  args: {
    name: v.string(),
    roleKey: v.string(),
    hashedKey: v.string(),
    prefix: v.string(),
    lastFour: v.string(),
  },
  handler: async (ctx, args) => {
    assertDev();
    await seedBuiltinRoles(ctx);

    // Attribute creation to the first admin profile if one exists (dev only).
    const admin = (await ctx.db.query("profiles").take(500)).find(
      (p) => p.role === "admin",
    );

    let account = await ctx.db
      .query("serviceAccounts")
      .withIndex("by_name", (q) => q.eq("name", args.name))
      .unique();
    let serviceAccountId: Id<"serviceAccounts">;
    if (account === null) {
      serviceAccountId = await ctx.db.insert("serviceAccounts", {
        name: args.name,
        roleKey: args.roleKey,
        disabled: false,
        description: "dev-seeded service account",
        // createdByUserId is required; fall back to the admin's userId if any.
        // In a fresh dev deployment with no admin yet, seed an admin first
        // (dev.makeAdmin) — but tolerate absence by reusing the account's own
        // future id is impossible, so require an admin to exist.
        createdByUserId: requireAdminUserId(admin),
      });
    } else {
      serviceAccountId = account._id;
      // Keep the roleKey in sync with what the caller asked for.
      if (account.roleKey !== args.roleKey) {
        await ctx.db.patch(serviceAccountId, { roleKey: args.roleKey });
      }
    }

    const keyId = await ctx.db.insert("apiKeys", {
      serviceAccountId,
      hashedKey: args.hashedKey,
      prefix: args.prefix,
      lastFour: args.lastFour,
      disabled: false,
      createdAt: Date.now(),
    });
    return { serviceAccountId, keyId };
  },
});

/** Helper: a dev seed still needs a createdByUserId; require an admin profile. */
function requireAdminUserId(
  admin: { userId: Id<"users"> } | undefined,
): Id<"users"> {
  if (!admin) {
    throw new Error(
      "dev.seedApiKey: no admin profile yet — sign in once (bootstrap admin) first",
    );
  }
  return admin.userId;
}

/**
 * Dev-gated mint: generate a fresh key (CSPRNG + SHA-256, action runtime),
 * persist it for a (created-or-reused) service account, and return the plaintext
 * ONCE. Use this for live-verifying /api/v1/traces from the CLI.
 *
 *   CONVEX_AGENT_MODE=anonymous npx convex run dev:seedApiKey \
 *     '{"name":"obs-cli","roleKey":"observer"}'
 */
export const seedApiKey = action({
  args: {
    name: v.string(),
    roleKey: v.optional(v.string()), // default "observer"
  },
  handler: async (
    ctx,
    { name, roleKey },
  ): Promise<{
    serviceAccountId: Id<"serviceAccounts">;
    keyId: Id<"apiKeys">;
    plaintext: string;
    prefix: string;
    lastFour: string;
  }> => {
    const generated = generateApiKey();
    const hashedKey = await hashKey(generated.plaintext);
    const { serviceAccountId, keyId } = await ctx.runMutation(
      internal.dev.seedApiKeyRecord,
      {
        name,
        roleKey: roleKey ?? "observer",
        hashedKey,
        prefix: generated.prefix,
        lastFour: generated.lastFour,
      },
    );
    return {
      serviceAccountId,
      keyId,
      plaintext: generated.plaintext,
      prefix: generated.prefix,
      lastFour: generated.lastFour,
    };
  },
});

export const reset = mutation({
  args: {},
  handler: async (ctx) => {
    assertDev();
    const tables = [
      "messageParts",
      "messages",
      "outbox",
      "uploads",
      "chats",
      "projects",
      "instances",
      "profiles",
      "appMeta",
      "groups",
      "auditLog",
      "serviceAccounts",
      "apiKeys",
      "roles",
      "traceEvents",
      "kpiRollups",
      "anomalies",
      "integrationCursors",
    ] as const;
    let deleted = 0;
    for (const table of tables) {
      // Bounded batches to stay within mutation limits on larger datasets.
      for (;;) {
        const batch = await ctx.db.query(table).take(200);
        if (batch.length === 0) break;
        for (const row of batch) {
          await ctx.db.delete(row._id);
          deleted++;
        }
        if (batch.length < 200) break;
      }
    }
    return { deleted };
  },
});
