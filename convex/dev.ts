// DEV-ONLY utilities. Every function here refuses to run unless the deployment
// has OPENCLAW_ENABLE_ANON_AUTH=1 (the same flag that enables the dev Anonymous
// auth provider). Never enabled in production.

import { v } from "convex/values";
import { mutation } from "./_generated/server";

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
      "profiles",
      "appMeta",
      "groups",
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
