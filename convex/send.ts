// Public send surface: the browser calls `sendMessage` to post a user turn.
//
// Flow (matches docs/ARCHITECTURE.md step 2):
//   1. Verify the authenticated user owns the chat.
//   2. Idempotency: if this (user, clientMessageId) was already accepted, return
//      the original ids without re-inserting or re-dispatching.
//   3. Verify the caller owns every attachment storageId (IDOR defense).
//   4. Insert an optimistic `user` message (status "complete") so it renders
//      immediately and reactively.
//   5. Insert an `outbox` row (status "pending") describing the work.
//   6. Schedule `bridge.dispatch` (internalAction) to push it to the bridge.
//
// The actual gateway dispatch happens in the scheduled internalAction
// (`convex/bridge.ts`) because mutations cannot do `fetch`. Secrets used to
// reach the bridge live only in deployment env, never here or in the browser.

import { v } from "convex/values";
import { mutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { ensureProfile, requireOwnedChat } from "./lib/access";
import { assertOwnsUpload } from "./uploads";

export const sendMessage = mutation({
  args: {
    chatId: v.id("chats"),
    text: v.string(),
    // Client-generated idempotency key (e.g. crypto.randomUUID()). REQUIRED: a
    // mutation can be retried transparently by the Convex client on a transient
    // failure, so the same logical send may arrive more than once. We dedupe on
    // (userId, clientMessageId) to guarantee exactly one user message + one
    // dispatch per logical send.
    clientMessageId: v.string(),
    // Attachments the browser already uploaded via
    // `ctx.storage.generateUploadUrl()`. Each carries the storage id plus the
    // browser-known filename/mimeType so the rendered part is accurate. Each
    // storageId MUST have been registered to this user (see uploads.ts);
    // otherwise it is rejected as an IDOR attempt.
    attachments: v.optional(
      v.array(
        v.object({
          storageId: v.id("_storage"),
          filename: v.string(),
          mimeType: v.string(),
        }),
      ),
    ),
  },
  handler: async (ctx, args) => {
    const userId = await ensureProfile(ctx);
    const chat = await requireOwnedChat(ctx, userId, args.chatId);

    // 2. Idempotency short-circuit. Run BEFORE any insert so a retry inserts
    //    neither a duplicate message nor a duplicate outbox row, and does not
    //    re-schedule the dispatch. Scoped by userId so one user's client ids
    //    can never collide with another's.
    const existing = await ctx.db
      .query("outbox")
      .withIndex("by_client_message", (q) =>
        q.eq("userId", userId).eq("clientMessageId", args.clientMessageId),
      )
      .unique();
    if (existing !== null) {
      return {
        messageId: existing.messageId ?? null,
        outboxId: existing._id,
        deduped: true as const,
      };
    }

    const now = Date.now();
    const attachments = args.attachments ?? [];

    // 3. IDOR defense: every attachment must be a blob THIS user uploaded.
    //    `assertOwnsUpload` throws (aborting the whole mutation) on any id that
    //    was not registered to the caller, so we never attach someone else's
    //    storage blob to a message.
    for (const attachment of attachments) {
      await assertOwnsUpload(ctx, userId, attachment.storageId);
    }

    // 4. Optimistic user message (immediately visible & reactive).
    const messageId = await ctx.db.insert("messages", {
      chatId: chat._id,
      userId,
      role: "user",
      status: "complete",
      text: args.text,
      updatedAt: now,
    });

    // Attach uploaded files as ordered parts on the user message so they render
    // in the thread, preserving the browser-supplied filename/mimeType.
    let order = 0;
    for (const attachment of attachments) {
      await ctx.db.insert("messageParts", {
        messageId,
        order: order++,
        part: {
          kind: "file",
          storageId: attachment.storageId,
          filename: attachment.filename,
          mimeType: attachment.mimeType,
        },
      });
    }

    // Keep the chat sorted-to-top.
    await ctx.db.patch(chat._id, { updatedAt: now });

    // 5. Outbox row describing the pending dispatch. `messageId` is stored so a
    //    deduped retry can return the original message id (see step 2).
    const outboxId = await ctx.db.insert("outbox", {
      chatId: chat._id,
      userId,
      clientMessageId: args.clientMessageId,
      messageId,
      text: args.text,
      attachmentIds: attachments.map((a) => a.storageId),
      status: "pending",
    });

    // 6. Schedule the dispatch to the bridge (cannot fetch from a mutation).
    await ctx.scheduler.runAfter(0, internal.bridge.dispatch, { outboxId });

    return { messageId, outboxId, deduped: false as const };
  },
});
