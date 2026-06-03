// Mutations called BY THE BRIDGE to stream normalized OpenClaw events into the
// reactive DB. These map 1:1 onto the normalizer's stable bridge events
// (see backend/app/normalizer.py and docs/BRIDGE_PROTOCOL.md):
//
//   run.status (begin)  -> startAssistant  (creates the streaming message)
//   message.delta       -> appendDelta     (append text)
//   message.snapshot    -> setSnapshot     (replace text)
//   tool.status / media -> addPart         (structured parts)
//   message.final       -> finalize        (complete | error | aborted)
//
// SECURITY: these are `internalMutation`s — NOT callable from the browser.
// The bridge authenticates to Convex with a deploy/service key (bridge env
// only) and invokes them via `internal.stream.*`. They therefore carry no
// user identity; access scoping for these writes is structural (the bridge is
// trusted and only writes to the chat it was told to). Public read access is
// still gated per-user in messages.ts, so a user can never read another user's
// streamed message.

import { v } from "convex/values";
import { internalMutation, MutationCtx } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { messagePart } from "./schema";
import { writeTraceEvent } from "./observability";

/**
 * Build the stable per-turn correlationId for an assistant message. Prefers
 * `chatId:runId` (the whole conversational turn); falls back to chatId, then to
 * the messageId, so a trace is always correlatable even mid-run.
 *
 * TODO(M8): the user half (send.ts traceSend) keys on `${chatId}:${outboxId}`,
 * which is never associated with this `${chatId}:${runId}`. Linking the two
 * halves end-to-end needs the bridge to carry a single correlationId across the
 * turn (write the runId back onto the outbox row, or echo a shared id through
 * startAssistant). Bridge wiring — deferred.
 */
function streamCorrelationId(
  chatId: Id<"chats">,
  runId: string | undefined,
  messageId: Id<"messages">,
): string {
  if (runId) return `${chatId}:${runId}`;
  if (chatId) return `${chatId}`;
  return `${messageId}`;
}

/**
 * Emit an `assistant.stream` trace (D2 metadata only — never message text).
 * Wrapped so a trace failure can NEVER abort the bridge's streaming mutation.
 */
async function traceStream(
  ctx: MutationCtx,
  args: {
    phase: "start" | "finalize";
    chatId: Id<"chats">;
    runId: string | undefined;
    messageId: Id<"messages">;
    streamStatus: "streaming" | "complete" | "error" | "aborted";
    textLen?: number;
  },
): Promise<void> {
  try {
    await writeTraceEvent(ctx, {
      kind: "assistant.stream",
      direction: "inbound",
      principalType: "system",
      principalId: "bridge",
      chatId: args.chatId,
      runId: args.runId,
      correlationId: streamCorrelationId(args.chatId, args.runId, args.messageId),
      meta: JSON.stringify({
        phase: args.phase,
        messageId: args.messageId,
        // String lifecycle status lives in meta (the `status` column is numeric).
        streamStatus: args.streamStatus,
        ...(args.textLen !== undefined ? { textLen: args.textLen } : {}),
      }),
    });
  } catch {
    // Best-effort: never break the primary stream write on a trace error.
  }
}

// Create the streaming assistant message for a run. Returns the message id the
// bridge then threads through the rest of the stream calls.
//
// We derive the owning user from the chat so the new message carries the same
// `userId` (needed for the per-user read scoping in messages.ts).
export const startAssistant = internalMutation({
  args: {
    chatId: v.id("chats"),
    runId: v.optional(v.string()),
  },
  handler: async (ctx, { chatId, runId }) => {
    const chat = await ctx.db.get(chatId);
    if (chat === null) {
      throw new Error("startAssistant: chat not found");
    }
    const now = Date.now();
    const messageId = await ctx.db.insert("messages", {
      chatId,
      userId: chat.userId,
      role: "assistant",
      runId,
      status: "streaming",
      text: "",
      updatedAt: now,
    });
    await ctx.db.patch(chatId, { updatedAt: now });
    await traceStream(ctx, {
      phase: "start",
      chatId,
      runId,
      messageId,
      streamStatus: "streaming",
    });
    return messageId;
  },
});

// Append incremental text (message.delta). Patch is the reactive primitive:
// the subscribed `listByChat` re-runs and assistant-ui re-renders.
export const appendDelta = internalMutation({
  args: {
    messageId: v.id("messages"),
    text: v.string(),
  },
  handler: async (ctx, { messageId, text }) => {
    const message = await ctx.db.get(messageId);
    if (message === null) {
      throw new Error("appendDelta: message not found");
    }
    await ctx.db.patch(messageId, {
      text: message.text + text,
      updatedAt: Date.now(),
    });
  },
});

// Replace the full text (message.snapshot).
export const setSnapshot = internalMutation({
  args: {
    messageId: v.id("messages"),
    text: v.string(),
  },
  handler: async (ctx, { messageId, text }) => {
    const message = await ctx.db.get(messageId);
    if (message === null) {
      throw new Error("setSnapshot: message not found");
    }
    await ctx.db.patch(messageId, { text, updatedAt: Date.now() });
  },
});

// Add a structured part (tool.status / media / file / reasoning). Order is
// assigned monotonically per message based on existing parts so rendering is
// stable. For media/file the bridge must have already stored the blob via
// `ctx.storage.store(blob)` (in an action) and pass the resulting `_storage`
// id inside `part`.
export const addPart = internalMutation({
  args: {
    messageId: v.id("messages"),
    part: messagePart,
  },
  handler: async (ctx, { messageId, part }) => {
    const message = await ctx.db.get(messageId);
    if (message === null) {
      throw new Error("addPart: message not found");
    }
    const existing = await ctx.db
      .query("messageParts")
      .withIndex("by_message", (q) => q.eq("messageId", messageId))
      .collect();
    const order = existing.length;
    await ctx.db.insert("messageParts", { messageId, order, part });
    await ctx.db.patch(messageId, { updatedAt: Date.now() });
  },
});

// Mark the assistant turn done (message.final). `status` is "complete" on a
// clean finish, "error" when the normalizer surfaced an error, or "aborted".
// Optional `text` lets the bridge set the final authoritative text (the
// normalizer's final event carries the accumulated text). On an error turn the
// bridge passes BOTH partial text and error (mirrors the lifecycle-error
// fixture: final text "moitié" + error containing "Context overflow").
export const finalize = internalMutation({
  args: {
    messageId: v.id("messages"),
    status: v.union(
      v.literal("complete"),
      v.literal("error"),
      v.literal("aborted"),
    ),
    text: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, { messageId, status, text, error }) => {
    const message = await ctx.db.get(messageId);
    if (message === null) {
      throw new Error("finalize: message not found");
    }
    await ctx.db.patch(messageId, {
      status,
      ...(text !== undefined ? { text } : {}),
      ...(error !== undefined ? { error } : {}),
      updatedAt: Date.now(),
    });
    // The finalized text length (final authoritative text if supplied, else the
    // accumulated message text) — never the text itself.
    const finalLen = (text ?? message.text).length;
    await traceStream(ctx, {
      phase: "finalize",
      chatId: message.chatId,
      runId: message.runId,
      messageId,
      streamStatus: status,
      textLen: finalLen,
    });
  },
});
