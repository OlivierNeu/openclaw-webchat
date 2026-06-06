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

describe("feedback admin view (increment B)", () => {
  // Seed one feedback filed by a regular user, return { owner, admin, feedbackId }.
  async function seedReported(t: ReturnType<typeof convexTest>) {
    const owner = await seedUser(t);
    const admin = await seedUser(t, "admin");
    const chatId = (await owner.as.mutation(api.chats.createChat, {})) as Id<"chats">;
    const { replyId } = await seedTurn(t, chatId, owner.userId, "ma question", "ma réponse");
    const res = await owner.as.mutation(api.feedback.submitFeedback, {
      chatId,
      messageId: replyId,
      category: "incorrect",
      comment: "secret comment",
      client: { displayedText: "ma réponse" },
    });
    return { owner, admin, feedbackId: res.feedbackId };
  }

  test("listForAdmin returns METADATA only, no message content", async () => {
    const t = convexTest(schema, modules);
    const { admin } = await seedReported(t);
    const rows = await admin.as.query(api.feedback.listForAdmin, {});
    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row.category).toBe("incorrect");
    expect(row.messageRole).toBe("assistant");
    expect(row.hasComment).toBe(true);
    // CRITICAL: no content leaks through the metadata list.
    expect("messageText" in row).toBe(false);
    expect("comment" in row).toBe(false);
    expect("snapshot" in row).toBe(false);
  });

  test("listForAdmin rejects a non-admin", async () => {
    const t = convexTest(schema, modules);
    const { owner } = await seedReported(t);
    await expect(owner.as.query(api.feedback.listForAdmin, {})).rejects.toThrow(
      /admin/i,
    );
  });

  test("readSnapshot returns content AND audits the cross-user read", async () => {
    const t = convexTest(schema, modules);
    const { owner, admin, feedbackId } = await seedReported(t);
    const res = await admin.as.mutation(api.feedback.readSnapshot, { feedbackId });
    // Content is returned (admin has no privacy block).
    expect(res.snapshot.messageText).toBe("ma réponse");
    expect(res.comment).toBe("secret comment");

    // The cross-user content read is traced: who read + whose data.
    const audit = await t.run(async (ctx) =>
      ctx.db
        .query("auditLog")
        .filter((q) => q.eq(q.field("action"), "feedback.read.content"))
        .collect(),
    );
    expect(audit.length).toBe(1);
    expect(audit[0].realUserId).toBe(admin.userId);
    expect(audit[0].effectiveUserId).toBe(owner.userId);
    expect(audit[0].impersonated).toBe(true); // admin != owner = cross-user
  });

  test("readSnapshot rejects a non-admin", async () => {
    const t = convexTest(schema, modules);
    const { owner, feedbackId } = await seedReported(t);
    await expect(
      owner.as.mutation(api.feedback.readSnapshot, { feedbackId }),
    ).rejects.toThrow(/admin/i);
  });

  test("deleteFeedback removes the row and audits it", async () => {
    const t = convexTest(schema, modules);
    const { admin, feedbackId } = await seedReported(t);
    await admin.as.mutation(api.feedback.deleteFeedback, { feedbackId });
    const gone = await t.run(async (ctx) => await ctx.db.get(feedbackId));
    expect(gone).toBeNull();
    const audit = await t.run(async (ctx) =>
      ctx.db
        .query("auditLog")
        .filter((q) => q.eq(q.field("action"), "feedback.delete"))
        .collect(),
    );
    expect(audit.length).toBe(1);
  });

  async function impersonate(
    t: ReturnType<typeof convexTest>,
    adminUserId: Id<"users">,
    targetUserId: Id<"users"> | undefined,
  ) {
    await t.run(async (ctx) => {
      const p = await ctx.db
        .query("profiles")
        .filter((q) => q.eq(q.field("userId"), adminUserId))
        .first();
      await ctx.db.patch(p!._id, { impersonatingUserId: targetUserId });
    });
  }

  test("admin responds → user sees thread + unread; mark read clears it; audited", async () => {
    const t = convexTest(schema, modules);
    const { owner, admin, feedbackId } = await seedReported(t);
    expect(await owner.as.query(api.feedback.myUnreadFeedbackCount, {})).toBe(0);

    await admin.as.mutation(api.feedback.respondToFeedback, {
      feedbackId,
      text: "Analysé : aucune altération côté serveur.",
    });

    const list = await owner.as.query(api.feedback.myFeedback, {});
    expect(list.length).toBe(1);
    expect(list[0].thread.length).toBe(1);
    expect(list[0].thread[0].authorRole).toBe("admin");
    expect(list[0].thread[0].text).toMatch(/Analysé/);
    expect(list[0].answered).toBe(true);
    expect(list[0].unread).toBe(true);
    expect(await owner.as.query(api.feedback.myUnreadFeedbackCount, {})).toBe(1);

    const audit = await t.run(async (ctx) =>
      ctx.db
        .query("auditLog")
        .filter((q) => q.eq(q.field("action"), "feedback.respond"))
        .collect(),
    );
    expect(audit.length).toBe(1);
    expect(audit[0].realUserId).toBe(admin.userId);
    expect(audit[0].effectiveUserId).toBe(owner.userId);

    await owner.as.mutation(api.feedback.markAllMyFeedbackRead, {});
    expect(await owner.as.query(api.feedback.myUnreadFeedbackCount, {})).toBe(0);
    const list2 = await owner.as.query(api.feedback.myFeedback, {});
    expect(list2[0].unread).toBe(false);
  });

  test("respondToFeedback rejects a non-admin", async () => {
    const t = convexTest(schema, modules);
    const { owner, feedbackId } = await seedReported(t);
    await expect(
      owner.as.mutation(api.feedback.respondToFeedback, { feedbackId, text: "x" }),
    ).rejects.toThrow(/admin/i);
  });

  test("markAllMyFeedbackRead is a NO-OP under impersonation (never clears the user's badge)", async () => {
    const t = convexTest(schema, modules);
    const { owner, admin, feedbackId } = await seedReported(t);
    await admin.as.mutation(api.feedback.respondToFeedback, {
      feedbackId,
      text: "réponse",
    });
    expect(await owner.as.query(api.feedback.myUnreadFeedbackCount, {})).toBe(1);

    // Admin investigates AS the owner and opens the bell (markAllRead).
    await impersonate(t, admin.userId, owner.userId);
    await admin.as.mutation(api.feedback.markAllMyFeedbackRead, {});
    await impersonate(t, admin.userId, undefined);

    // The owner's badge MUST still be unread — the admin peeking didn't clear it.
    expect(await owner.as.query(api.feedback.myUnreadFeedbackCount, {})).toBe(1);
    // The real user clearing it works.
    await owner.as.mutation(api.feedback.markAllMyFeedbackRead, {});
    expect(await owner.as.query(api.feedback.myUnreadFeedbackCount, {})).toBe(0);
  });
});
