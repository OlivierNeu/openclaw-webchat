// Convex -> Bridge dispatch.
//
// `sendMessage` (send.ts) schedules `dispatch` after inserting the outbox row.
// `dispatch` is an internalAction (only it can `fetch`) that POSTs the pending
// message to the bridge's authenticated `POST /send` endpoint, then marks the
// outbox row sent/failed via an internalMutation.
//
// SECURITY / DEPLOYMENT (load-bearing):
//   - `BRIDGE_URL` and `BRIDGE_SHARED_SECRET` are read from DEPLOYMENT ENV
//     (set with `npx convex env set ...`), NEVER from tables or the browser.
//   - These are internal functions: not part of the public (browser) API.
//   - REQUIRES A LIVE DEPLOYMENT + a reachable bridge to actually send; the
//     `fetch` here only runs server-side on Convex.

import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";

// Read a single outbox row (used by the dispatch action, which has no db
// access of its own — actions read via queries).
export const getOutbox = internalQuery({
  args: { outboxId: v.id("outbox") },
  handler: async (ctx, { outboxId }): Promise<Doc<"outbox"> | null> => {
    return await ctx.db.get(outboxId);
  },
});

// Mark an outbox row's terminal status after the dispatch attempt.
export const markOutbox = internalMutation({
  args: {
    outboxId: v.id("outbox"),
    status: v.union(v.literal("sent"), v.literal("failed")),
  },
  handler: async (ctx, { outboxId, status }) => {
    const row = await ctx.db.get(outboxId);
    if (row === null) {
      return; // row gone; nothing to do
    }
    await ctx.db.patch(outboxId, { status });
  },
});

// Fetch the OpenClaw chat id for routing (non-secret metadata) so the bridge
// can address the right thread. Reads via the chat the outbox row references.
export const getChatRouting = internalQuery({
  args: { chatId: v.id("chats") },
  handler: async (ctx, { chatId }) => {
    const chat = await ctx.db.get(chatId);
    if (chat === null) {
      return null;
    }
    return { openclawChatId: chat.openclawChatId ?? null };
  },
});

export const dispatch = internalAction({
  args: { outboxId: v.id("outbox") },
  handler: async (ctx, { outboxId }) => {
    const row = await ctx.runQuery(internal.bridge.getOutbox, { outboxId });
    if (row === null) {
      return; // nothing to dispatch
    }
    if (row.status !== "pending") {
      return; // already handled (guards duplicate schedules)
    }

    const bridgeUrl = process.env.BRIDGE_URL;
    const sharedSecret = process.env.BRIDGE_SHARED_SECRET;
    if (!bridgeUrl || !sharedSecret) {
      // Misconfiguration: mark the row failed so it is visible. We do NOT throw,
      // because a thrown action is retried by Convex — and a retry would re-POST
      // (or re-fail) without the operator having fixed anything. The "failed"
      // row is the durable, queryable signal.
      console.error(
        "bridge.dispatch: BRIDGE_URL / BRIDGE_SHARED_SECRET not configured",
      );
      await ctx.runMutation(internal.bridge.markOutbox, {
        outboxId,
        status: "failed",
      });
      return;
    }

    const routing = await ctx.runQuery(internal.bridge.getChatRouting, {
      chatId: row.chatId as Id<"chats">,
    });

    // We mark the row terminal (sent/failed) and deliberately do NOT re-throw on
    // a transient bridge error. Re-throwing triggers Convex action retries,
    // which would re-POST after we already recorded "failed" -> duplicate sends.
    // The bridge MUST additionally dedupe on `clientMessageId` (it builds an
    // OpenClaw idempotencyKey from it) so even an at-least-once delivery here is
    // safe; retry/reconciliation is the operator's explicit action on a failed
    // row, not an implicit re-fire.
    let ok = false;
    try {
      const response = await fetch(`${bridgeUrl.replace(/\/$/, "")}/send`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Shared secret authenticates Convex -> bridge (server-to-server).
          Authorization: sharedSecret,
        },
        body: JSON.stringify({
          chatId: row.chatId,
          openclawChatId: routing?.openclawChatId ?? null,
          text: row.text,
          clientMessageId: row.clientMessageId,
          attachments: row.attachmentIds,
        }),
      });
      ok = response.ok;
      if (!ok) {
        console.error(`bridge POST /send -> HTTP ${response.status}`);
      }
    } catch (err) {
      console.error("bridge POST /send failed:", err);
      ok = false;
    }

    await ctx.runMutation(internal.bridge.markOutbox, {
      outboxId,
      status: ok ? "sent" : "failed",
    });
  },
});
