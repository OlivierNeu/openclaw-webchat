/// <reference types="vite/client" />
//
// UI-9 forensic feedback: unit tests for `feedback.submitFeedback`.
//
// Pins the invariants the live browser run does NOT prove deterministically and
// that the WHOLE forensic value depends on:
//   1. SERVER-READ truth — `snapshot.messageText` comes from the DB, never from
//      the client. A forged `displayedText` cannot rewrite the stored content; it
//      only flips `displayedMatchesStored` (the browser-fidelity signal).
//   2. CONTEXT capture — the preceding user prompt + message parts are frozen.
//   3. OWNERSHIP — a user cannot report another user's message.
//   4. AUDIT — a report filed while impersonating is attributed to the REAL
//      admin id (realUserId), with impersonated=true.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { Id } from "./_generated/dataModel";

const modules = import.meta.glob("./**/*.ts");

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role: "user" | "admin" = "user",
) {
  const userId = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId, role });
    return userId;
  });
  return { userId, as: t.withIdentity({ subject: `${userId}|session` }) };
}

/** Seed a prompt(user) + reply(assistant, with one tool part) into a chat. */
async function seedTurn(
  t: ReturnType<typeof convexTest>,
  chatId: Id<"chats">,
  userId: Id<"users">,
  promptText: string,
  replyText: string,
) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const promptId = await ctx.db.insert("messages", {
      chatId,
      userId,
      role: "user",
      status: "complete",
      text: promptText,
      updatedAt: now,
    });
    const replyId = await ctx.db.insert("messages", {
      chatId,
      userId,
      role: "assistant",
      status: "complete",
      runId: "run-123",
      text: replyText,
      updatedAt: now + 1,
    });
    await ctx.db.insert("messageParts", {
      messageId: replyId,
      order: 0,
      part: { kind: "tool", name: "search", phase: "completed", input: { q: "x" }, output: "y" },
    });
    return { promptId, replyId };
  });
}

describe("feedback.submitFeedback", () => {
  test("snapshot.messageText is server-read; forged displayedText only flips the fidelity flag", async () => {
    const t = convexTest(schema, modules);
    const { userId, as } = await seedUser(t);
    const chatId = (await as.mutation(api.chats.createChat, {})) as Id<"chats">;
    const REPLY = "Le mot exact: détours.";
    const { replyId } = await seedTurn(t, chatId, userId, "ma question", REPLY);

    // (a) Honest report: the browser shows exactly the stored text -> match=true,
    //     and the full generating context is frozen.
    const ok = await as.mutation(api.feedback.submitFeedback, {
      chatId,
      messageId: replyId,
      category: "altered_words",
      comment: "un mot semble changé",
      client: { displayedText: REPLY, sourceWasOpen: true, language: "fr-CA" },
    });
    expect(ok.displayedMatchesStored).toBe(true);

    // (b) FORGERY ATTEMPT: client lies about what was displayed. The stored
    //     snapshot MUST still be the server's truth; only the flag goes false.
    const forged = await as.mutation(api.feedback.submitFeedback, {
      chatId,
      messageId: replyId,
      category: "altered_words",
      client: { displayedText: "TEXTE FORGÉ PAR LE CLIENT" },
    });
    expect(forged.displayedMatchesStored).toBe(false);

    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("feedback")
        .withIndex("by_message", (q) => q.eq("messageId", replyId))
        .collect(),
    );
    expect(rows.length).toBe(2);
    for (const r of rows) {
      // Server truth is identical in BOTH rows regardless of client claims.
      expect(r.snapshot.messageText).toBe(REPLY);
      expect(r.snapshot.messageRole).toBe("assistant");
      expect(r.snapshot.runId).toBe("run-123");
      expect(r.snapshot.promptText).toBe("ma question");
      expect(r.snapshot.partsCount).toBe(1);
      expect(r.snapshot.contextCount).toBeGreaterThanOrEqual(2);
      expect(r.snapshot.contextWindowLimit).toBe(12);
    }
    expect(rows.find((r) => r.snapshot.displayedMatchesStored === false)).toBeTruthy();
  });

  test("owner-scope: a user cannot report another user's message", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedUser(t);
    const intruder = await seedUser(t);
    const chatId = (await owner.as.mutation(api.chats.createChat, {})) as Id<"chats">;
    const { replyId } = await seedTurn(t, chatId, owner.userId, "q", "r");

    await expect(
      intruder.as.mutation(api.feedback.submitFeedback, {
        chatId,
        messageId: replyId,
        category: "incoherence",
      }),
    ).rejects.toThrow(/forbidden/i);

    const count = await t.run(async (ctx) => (await ctx.db.query("feedback").collect()).length);
    expect(count).toBe(0);
  });

  test("rejects an invalid category", async () => {
    const t = convexTest(schema, modules);
    const { userId, as } = await seedUser(t);
    const chatId = (await as.mutation(api.chats.createChat, {})) as Id<"chats">;
    const { replyId } = await seedTurn(t, chatId, userId, "q", "r");

    await expect(
      as.mutation(api.feedback.submitFeedback, {
        chatId,
        messageId: replyId,
        category: "not_a_category",
      }),
    ).rejects.toThrow(/category/i);
  });

  test("a report filed while impersonating is audited with the real admin id", async () => {
    const t = convexTest(schema, modules);
    const target = await seedUser(t); // the impersonated user owns the chat
    const admin = await seedUser(t, "admin");
    // Admin starts impersonating the target (effective identity flips to target).
    await t.run(async (ctx) => {
      const adminProfile = await ctx.db
        .query("profiles")
        .filter((q) => q.eq(q.field("userId"), admin.userId))
        .first();
      await ctx.db.patch(adminProfile!._id, { impersonatingUserId: target.userId });
    });

    const chatId = (await target.as.mutation(api.chats.createChat, {})) as Id<"chats">;
    const { replyId } = await seedTurn(t, chatId, target.userId, "q", "r");

    // The admin (acting AS target) files the report.
    await admin.as.mutation(api.feedback.submitFeedback, {
      chatId,
      messageId: replyId,
      category: "incorrect",
    });

    const audit = await t.run(async (ctx) =>
      ctx.db
        .query("auditLog")
        .filter((q) => q.eq(q.field("action"), "feedback.submit"))
        .collect(),
    );
    expect(audit.length).toBe(1);
    expect(audit[0].realUserId).toBe(admin.userId);
    expect(audit[0].effectiveUserId).toBe(target.userId);
    expect(audit[0].impersonated).toBe(true);

    // The feedback row itself records both identities for attribution.
    const fb = await t.run(async (ctx) => (await ctx.db.query("feedback").collect())[0]);
    expect(fb.realUserId).toBe(admin.userId);
    expect(fb.userId).toBe(target.userId);
    expect(fb.impersonated).toBe(true);
  });
});
