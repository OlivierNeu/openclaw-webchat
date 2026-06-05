// DEV-ONLY utilities. Every function here refuses to run unless the deployment
// has OPENCLAW_ENABLE_ANON_AUTH=1 (the same flag that enables the dev Anonymous
// auth provider). Never enabled in production.

import { v } from "convex/values";
import { action, internalMutation, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { generateApiKey, hashKey } from "./lib/apikeys";
import { seedBuiltinRoles } from "./lib/rbac";
import { resolveTargetForProfile } from "./routing";

function assertDev() {
  if (process.env.OPENCLAW_ENABLE_ANON_AUTH !== "1") {
    throw new Error("dev.* is disabled (OPENCLAW_ENABLE_ANON_AUTH != 1)");
  }
}

// SAFETY (red-team must-fix): live tests hit ONLY the olivier DEV instance
// ("admin"/gateway.lacneu.com) — NEVER jerome ("family"/ataraxis, the protected
// instance). Code-enforced, not just prose: routeUser + testSend refuse any
// instance outside this allowlist so no autonomous live test can reach prod.
const DEV_LIVE_ALLOWED_INSTANCES = new Set(["admin"]);
function assertDevInstance(instanceName: string): void {
  if (!DEV_LIVE_ALLOWED_INSTANCES.has(instanceName)) {
    throw new Error(
      `dev live ops restricted to [${[...DEV_LIVE_ALLOWED_INSTANCES].join(
        ", ",
      )}] — refusing "${instanceName}" (never touch jerome/family)`,
    );
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

/**
 * LIVE-VERIFY HELPER for the global search index. The real path
 * (search.searchConversations) is auth-gated, so a bare `npx convex run` can't
 * exercise it. This dev-gated query runs the SAME raw `withSearchIndex` against
 * the live deployment so the production search index can be confirmed to return
 * hits (and that the `userId` filter scopes) from the CLI:
 *
 *   npx convex run dev:searchProbe '{"term":"drive"}'
 *   npx convex run dev:searchProbe '{"term":"drive","userId":"<id>"}'
 *
 * When `userId` is omitted it scopes to the first message's owner so a single
 * probe works without knowing an id.
 */
export const searchProbe = query({
  args: { term: v.string(), userId: v.optional(v.id("users")) },
  handler: async (ctx, { term, userId }) => {
    assertDev();
    let uid = userId;
    if (!uid) {
      const anyMsg = await ctx.db.query("messages").take(1);
      uid = anyMsg[0]?.userId;
    }
    if (!uid) return { ok: false as const, reason: "no messages to scope" };
    const hits = await ctx.db
      .query("messages")
      .withSearchIndex("search_text", (q) =>
        q.search("text", term).eq("userId", uid),
      )
      .take(5);
    return {
      ok: true as const,
      scopedUserId: uid,
      count: hits.length,
      chatIds: hits.map((m) => m.chatId),
    };
  },
});

/**
 * LIVE-BRIDGE ROUTING (dev-gated). Wire the test user(s) to one OpenClaw instance
 * so `bridge.dispatch` resolves a non-null target and POSTs to the bridge instead
 * of marking the outbox `failed` (the "unrouted" path). Upserts the non-secret
 * `instances` row (the bridge maps name -> token/deviceIdentity from its OWN env;
 * gatewayUrl here is display/metadata only) and sets a per-user OVERRIDE on the
 * matching profile(s).
 *
 *   npx convex run dev:routeUser \
 *     '{"instanceName":"admin","gatewayUrl":"wss://gateway.lacneu.com","agentId":"olivier","canonical":"olivier"}'
 *
 * With no `email`, routes EVERY active (user|admin) profile — foolproof on a
 * single-operator dev box where several stale sessions may exist. Pass `email`
 * to target one profile.
 */
export const routeUser = mutation({
  args: {
    instanceName: v.string(),
    gatewayUrl: v.string(),
    agentId: v.string(),
    canonical: v.string(),
    email: v.optional(v.string()),
  },
  handler: async (ctx, { instanceName, gatewayUrl, agentId, canonical, email }) => {
    assertDev();
    assertDevInstance(instanceName); // never route a profile to jerome/family

    // Upsert the non-secret instance row (name == secret-store group key).
    const existing = await ctx.db
      .query("instances")
      .withIndex("by_name", (q) => q.eq("name", instanceName))
      .unique();
    if (existing === null) {
      await ctx.db.insert("instances", {
        name: instanceName,
        gatewayUrl,
        displayName: instanceName,
      });
    } else {
      await ctx.db.patch(existing._id, { gatewayUrl });
    }

    // Route the matching active profile(s) via a per-user override.
    const profiles = await ctx.db.query("profiles").take(500);
    const targets = profiles.filter(
      (p) =>
        (p.role === "admin" || p.role === "user") &&
        (email ? p.email === email : true),
    );
    const routed: Array<{
      userId: Id<"users">;
      email: string | null;
      role: string;
      target: Awaited<ReturnType<typeof resolveTargetForProfile>>;
    }> = [];
    for (const p of targets) {
      await ctx.db.patch(p._id, {
        overrideInstance: instanceName,
        overrideAgentId: agentId,
        canonical,
      });
      const fresh = await ctx.db.get(p._id);
      const target = await resolveTargetForProfile(ctx, fresh);
      routed.push({
        userId: p.userId,
        email: p.email ?? null,
        role: p.role as string,
        target,
      });
    }

    return { ok: true, instance: instanceName, gatewayUrl, routedCount: routed.length, routed };
  },
});

/**
 * LIVE-TEST TRIGGER (dev-gated). Programmatically enqueue a user turn for the
 * routed test profile — the same path the browser's send.sendMessage takes
 * (optimistic user message + outbox row + scheduled bridge.dispatch) — so the
 * live harness can drive a round-trip WITHOUT a browser click. The scheduled
 * dispatch resolves routing (overrideInstance) and POSTs to the bridge, which
 * connects to the gateway and streams the reply back into Convex.
 *
 *   npx convex run dev:testSend '{"text":"hello from the live harness"}'
 *
 * Returns the chatId so a follow-up run can continue the same conversation, and
 * so the harness can poll `messages` by chat for the assistant's final state.
 */
export const testSend = mutation({
  args: { text: v.string(), chatId: v.optional(v.id("chats")) },
  handler: async (ctx, { text, chatId }) => {
    assertDev();

    // Resolve the sending user: if a chatId is given, send as THAT chat's owner
    // (so the harness can drive any conversation); otherwise pick a routed profile.
    const profiles = await ctx.db.query("profiles").take(500);
    let owner: (typeof profiles)[number] | undefined;
    if (chatId) {
      const chat = await ctx.db.get(chatId);
      if (!chat) return { ok: false as const, reason: "chat not found" };
      owner = profiles.find((p) => p.userId === chat.userId);
      if (!owner) return { ok: false as const, reason: "chat owner has no profile" };
    } else {
      owner =
        profiles.find((p) => p.overrideInstance) ??
        profiles.find((p) => p.role === "admin") ??
        profiles[0];
    }
    if (!owner) return { ok: false as const, reason: "no routed profile" };
    // SAFETY: only fire a live send for a user routed to an allowlisted dev
    // instance — never let a stray routing reach jerome/family.
    if (!owner.overrideInstance) {
      return { ok: false as const, reason: "test user not routed (run dev.routeUser first)" };
    }
    assertDevInstance(owner.overrideInstance);
    const userId = owner.userId;
    const now = Date.now();

    const cid: Id<"chats"> =
      chatId ??
      (await ctx.db.insert("chats", {
        userId,
        title: "Live test",
        archived: false,
        sortKey: -1000,
        updatedAt: now,
      }));

    // Mirror send.sendMessage: optimistic user message + outbox + dispatch.
    const messageId = await ctx.db.insert("messages", {
      chatId: cid,
      userId,
      role: "user",
      status: "complete",
      text,
      updatedAt: now,
    });
    await ctx.db.patch(cid, { updatedAt: now });

    const outboxId = await ctx.db.insert("outbox", {
      chatId: cid,
      userId,
      clientMessageId: `live-${messageId}`,
      messageId,
      text,
      attachmentIds: [],
      status: "pending",
    });
    await ctx.scheduler.runAfter(0, internal.bridge.dispatch, { outboxId });

    return { ok: true as const, chatId: cid, messageId, outboxId };
  },
});

/**
 * LIVE-HARNESS ORACLE (dev-gated, read-only). Clean view of a chat's latest
 * messages + their part kinds/names + A2 text/liveText lengths — the
 * deterministic check the live matrix polls (avoids parsing `convex data` column
 * output).
 *
 *   npx convex run dev:inspectChat '{"chatId":"<id>"}'
 */
export const inspectChat = query({
  args: { chatId: v.id("chats") },
  handler: async (ctx, { chatId }) => {
    assertDev();
    const msgs = await ctx.db
      .query("messages")
      .withIndex("by_chat", (q) => q.eq("chatId", chatId))
      .order("desc")
      .take(6);
    const out = [];
    for (const m of msgs) {
      const parts = await ctx.db
        .query("messageParts")
        .withIndex("by_message", (q) => q.eq("messageId", m._id))
        .collect();
      out.push({
        role: m.role,
        status: m.status,
        textLen: m.text.length,
        liveTextLen: (m.liveText ?? "").length,
        textPreview: m.text.slice(0, 80),
        parts: parts.map((p) => ({
          kind: p.part.kind,
          name: "name" in p.part ? p.part.name : undefined,
          phase: "phase" in p.part ? p.part.phase : undefined,
        })),
      });
    }
    return out.reverse();
  },
});

/**
 * Resolve the MOST RECENT media attachment in a chat to {filename, mimeType,
 * url} + dedup signals. Used by the per-version file-exchange smoke test to
 * byte-compare the served bytes against the source file and assert exactly one
 * media part + no dead link. Dev-gated like the rest of this module.
 *   npx convex run dev:lastMediaPart '{"chatId":"<id>"}'
 */
export const lastMediaPart = query({
  args: { chatId: v.id("chats") },
  handler: async (ctx, { chatId }) => {
    assertDev();
    const msgs = await ctx.db
      .query("messages")
      .withIndex("by_chat", (q) => q.eq("chatId", chatId))
      .order("desc")
      .take(8);
    for (const m of msgs) {
      const parts = await ctx.db
        .query("messageParts")
        .withIndex("by_message", (q) => q.eq("messageId", m._id))
        .collect();
      const media = [...parts].reverse().find((p) => p.part.kind === "media");
      if (media && media.part.kind === "media") {
        return {
          filename: media.part.filename,
          mimeType: media.part.mimeType,
          url: await ctx.storage.getUrl(media.part.storageId),
          // Terminal status of the turn that produced this attachment — used by
          // the stability test to count complete vs error turns per version.
          status: m.status,
          // dedup check (must be 1) + dead-link check (must be false).
          mediaCount: parts.filter((p) => p.part.kind === "media").length,
          textHasDeadLink:
            m.text.includes("](./media/") || m.text.includes("MEDIA:"),
        };
      }
    }
    return null;
  },
});

/**
 * Last message's role/status/creationTime — used by the stability test to detect
 * a NEW assistant turn finalizing (complete/error) regardless of whether it
 * produced an attachment, so it measures app-server stability (the
 * "codex app-server client closed" irritation) rather than agent MEDIA: compliance.
 *   npx convex run dev:chatStats '{"chatId":"<id>"}'
 */
export const chatStats = query({
  args: { chatId: v.id("chats") },
  handler: async (ctx, { chatId }) => {
    assertDev();
    const last = await ctx.db
      .query("messages")
      .withIndex("by_chat", (q) => q.eq("chatId", chatId))
      .order("desc")
      .take(1);
    const m = last[0];
    return m
      ? {
          lastRole: m.role,
          lastStatus: m.status,
          lastCreated: m._creationTime,
          // System error string (e.g. "codex app-server client closed before
          // turn completed") — non-PHI, lets the stability test classify the
          // irritation. Truncated.
          lastError: m.error ? m.error.slice(0, 100) : undefined,
        }
      : null;
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
