// Public, reactive read surface for chat messages.
//
// `listByChat` is what the frontend subscribes to via `useQuery`. assistant-ui
// turns each returned message (with its resolved parts) into a
// ThreadMessageLike. Streaming works because the bridge patches the underlying
// `messages.text` / inserts `messageParts`, which re-runs this query and
// re-renders the thread.
//
// ACCESS CONTROL: scoped to the authenticated user. A user can only read
// messages in a chat they own.
//
// BOUND (load-bearing — see Convex guidelines: never .collect() unbounded):
// we read AT MOST `MESSAGE_WINDOW` most-recent messages via the `by_chat`
// index in descending creation order, then present them chronologically.
// Messages older than the window are intentionally NOT returned by this
// reactive query; a full-history/scrollback view should paginate (see
// `listByChatPaginated`) rather than widen this window.

import { v } from "convex/values";
import { query, mutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { requireActive, requireOwnedChat } from "./lib/access";
import { auditImpersonated } from "./lib/audit";
import { deleteFilesByMessage } from "./lib/files";
import { enrichUserAgents, resolveAgentForChat } from "./agents";

// Hard upper bound on how many recent messages the reactive feed loads. Chosen
// to cover a typical visible conversation while keeping the query (and the
// per-message part fan-out below) cheap and bounded. Older history must be
// reached via pagination, not by raising this.
const MESSAGE_WINDOW = 200;

// A part as returned to the client. For media/file parts we resolve the Convex
// storage id to a signed URL (`url`) so the browser can render it directly;
// the raw storageId is intentionally NOT returned.
type ClientPart =
  | { kind: "tool"; name: string; phase: string; input?: unknown; output?: unknown }
  | { kind: "media"; url: string | null; filename: string; mimeType: string }
  | { kind: "file"; url: string | null; filename: string; mimeType: string }
  | { kind: "reasoning"; text: string };

export const listByChat = query({
  // v.string (NOT v.id): the chatId comes straight from the URL (/chat/$chatId)
  // and may be malformed (a truncated/typo'd deep link). With v.id, a bad value
  // throws an ArgumentValidationError that surfaces as the router's raw
  // "Something went wrong" screen — the opposite of a clean app-shell message.
  // We accept a string and validate via normalizeId instead.
  args: { chatId: v.string() },
  handler: async (ctx, { chatId }) => {
    const { userId } = await requireActive(ctx);
    // normalizeId validates the id FORMAT for this table WITHOUT throwing (null on
    // a malformed shape). A well-formed-but-deleted id passes here, then db.get
    // returns null — so malformed AND deleted both funnel to the same clean empty
    // result the client renders as "conversation introuvable". A chat owned by
    // someone else still throws (an IDOR signal, handled by the route fallback).
    const id = ctx.db.normalizeId("chats", chatId);
    if (id === null) return [];
    const chat = await ctx.db.get(id);
    if (chat === null) return [];
    if (chat.userId !== userId) throw new Error("Forbidden: chat not owned by user");

    // Bounded read: most-recent MESSAGE_WINDOW messages, newest first.
    const recentDesc = await ctx.db
      .query("messages")
      .withIndex("by_chat", (q) => q.eq("chatId", id))
      .order("desc")
      .take(MESSAGE_WINDOW);

    // Present chronologically (oldest -> newest) for rendering. The index's
    // descending order is already by creation time, so reversing is sufficient
    // and stable (no extra _creationTime sort needed).
    const messages = recentDesc.reverse();

    // Batch part resolution: fetch each message's parts in parallel. Convex has
    // no SQL join, so this is per-message — but the message set is bounded by
    // MESSAGE_WINDOW, so the fan-out is bounded too. Within a message, parts are
    // bounded by how many the bridge appended for that turn.
    const result = await Promise.all(
      messages.map(async (message) => {
        const partDocs = await ctx.db
          .query("messageParts")
          .withIndex("by_message", (q) => q.eq("messageId", message._id))
          .collect();
        partDocs.sort((a, b) => a.order - b.order);

        const parts: ClientPart[] = [];
        for (const { part } of partDocs) {
          switch (part.kind) {
            case "tool":
              parts.push({
                kind: "tool",
                name: part.name,
                phase: part.phase,
                input: part.input,
                output: part.output,
              });
              break;
            case "media":
            case "file": {
              // Resolve storage id -> signed URL. Requires a live deployment to
              // produce a real URL; offline this returns null.
              const url = await ctx.storage.getUrl(part.storageId);
              parts.push({
                kind: part.kind,
                url,
                filename: part.filename,
                mimeType: part.mimeType,
              });
              break;
            }
            case "reasoning":
              parts.push({ kind: "reasoning", text: part.text });
              break;
          }
        }

        return {
          _id: message._id,
          chatId: message.chatId,
          _creationTime: message._creationTime,
          role: message.role,
          status: message.status,
          runId: message.runId,
          // A2 streaming: while streaming, the live tokens are in the un-indexed
          // `liveText`; at finalize the authoritative copy is in `text` and
          // `liveText` is cleared. Surface one `text` the client renders verbatim
          // (token-by-token live, then final) — no frontend change needed.
          text:
            message.status === "streaming"
              ? (message.liveText ?? message.text)
              : message.text,
          error: message.error,
          updatedAt: message.updatedAt,
          parts,
        };
      }),
    );

    return result;
  },
});

// Chat-header read: the chat's title + OpenClaw session meta (model, reasoning
// level + its enum, verbosity, and the context-usage counts) so the top strip
// can render the model/reasoning chips + context meter. Owner-scoped; resilient
// to a just-deleted chat (returns null instead of throwing, so the reactive
// header does not error while the active chat is being removed).
export const getSessionMeta = query({
  // v.string + normalizeId (same rationale as listByChat): tolerate a malformed
  // URL chatId. Returns null for a malformed/deleted chat so the header renders
  // the clean "introuvable" state instead of throwing the router error screen.
  args: { chatId: v.string() },
  handler: async (ctx, { chatId }) => {
    const { userId } = await requireActive(ctx);
    const id = ctx.db.normalizeId("chats", chatId);
    if (id === null) return null;
    const chat = await ctx.db.get(id);
    if (chat === null) return null;
    if (chat.userId !== userId) {
      throw new Error("Forbidden: chat not owned by user");
    }
    return {
      title: chat.title ?? null,
      sessionMeta: chat.sessionMeta ?? null,
      // The user's explicit write-back intent (reasoning/model). The panel uses
      // it to mark which knob is an override vs inherited; the chip itself reads
      // sessionMeta (live truth).
      sessionSettings: chat.sessionSettings ?? null,
    };
  },
});

// Optional: list the chats owned by the authenticated user (sidebar). Scoped.
export const listChats = query({
  args: {},
  handler: async (ctx) => {
    const { userId } = await requireActive(ctx);
    const chats = await ctx.db
      .query("chats")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    // Single comparator: pinned first, then manual sortKey (asc), then recency.
    // Manual order WINS over recency (user explicitly drags); recency is only a
    // tiebreaker for chats that have never been ordered.
    chats.sort((a, b) => {
      const pa = a.pinned ? 0 : 1;
      const pb = b.pinned ? 0 : 1;
      if (pa !== pb) return pa - pb;
      const ka = a.sortKey ?? 0;
      const kb = b.sortKey ?? 0;
      if (ka !== kb) return ka - kb;
      return b.updatedAt - a.updatedAt;
    });

    // Per-chat provider kind (OpenClaw vs Hermes) for the sidebar's self-hiding
    // bridge badge. Resolved through the SAME `resolveAgentForChat` the header
    // chip uses (and that mirrors dispatch): a chat bound to a deleted/revoked
    // agent — or with a deleted default — resolves to the agent the NEXT turn
    // actually uses, so the badge can't name a bridge that won't handle the turn.
    // BATCHED: `enrichUserAgents` loads the user's agents + their instance kinds
    // ONCE (it already maps a kind-unset legacy instance to "openclaw"); then each
    // chat is mapped purely. The frontend shows the badge ONLY when chats span >1
    // kind (invisible until Hermes).
    const agents = await enrichUserAgents(ctx, userId);
    const kindOf = (c: { instanceName?: string; agentId?: string }) =>
      resolveAgentForChat(agents, c)?.kind ?? null;

    return chats
      .filter((c) => !c.archived)
      .map((c) => ({
        _id: c._id as Id<"chats">,
        title: c.title,
        updatedAt: c.updatedAt,
        projectId: c.projectId ?? null,
        sortKey: c.sortKey ?? 0,
        pinned: c.pinned ?? false,
        color: c.color ?? null,
        providerKind: kindOf(c),
      }));
  },
});

// Delete a message (owner-scoped) with the TRUNCATE-FORWARD semantics the product
// requires, PLUS the gateway realignment the trust requirement demands:
//   - User message deleted      -> delete it + ALL following turns (rewind).
//   - Assistant message deleted -> delete it + ALL following, then RE-RUN the
//     now-last user message (regenerate). For the LAST assistant turn (the common
//     case) this is exactly "delete + regenerate"; for a mid-thread one it rewinds
//     to that point then regenerates (a coherent superset of the literal ask).
// CRITICAL (advisor): deleting in Convex does NOT remove the turn from the OpenClaw
// SESSION context. So on every truncating delete we schedule a `sessions.reset`
// (bridge): reset -> systemSent=false -> the next turn re-hydrates from the
// TRUNCATED Convex state, realigning the gateway. Without it the model would keep
// reasoning over turns the user deleted and no longer sees — a trust violation.
// (docs/SESSION_CONTINUITY_DESIGN.md; OUTCOME proof gated on NAS #62.)
export const deleteMessage = mutation({
  args: { messageId: v.id("messages") },
  handler: async (ctx, { messageId }) => {
    const { userId, actor } = await requireActive(ctx);
    const message = await ctx.db.get(messageId);
    if (message === null) return; // already gone (e.g. double-click)
    const chat = await requireOwnedChat(ctx, userId, message.chatId);

    // Do not delete a turn mid-stream — the bridge's finalize would then throw on
    // a missing message. Ask the user to wait for the reply to settle.
    if (message.status === "streaming") {
      throw new Error("Patientez la fin de la réponse avant de supprimer.");
    }

    const wasAssistant = message.role === "assistant";
    const cutoff = message._creationTime;

    // This message + every later one in the chat (truncate forward). Bounded read.
    const chatMessages = await ctx.db
      .query("messages")
      .withIndex("by_chat", (q) => q.eq("chatId", chat._id))
      .collect();
    for (const m of chatMessages) {
      if (m._creationTime < cutoff) continue;
      const parts = await ctx.db
        .query("messageParts")
        .withIndex("by_message", (q) => q.eq("messageId", m._id))
        .collect();
      for (const p of parts) await ctx.db.delete(p._id);
      // Mirror the files-row invariant on the part deletion (delete + regenerate).
      await deleteFilesByMessage(ctx, m._id);
      await ctx.db.delete(m._id);
    }

    // Drop this chat's pending outbox so a stale dispatch cannot resurrect a
    // deleted turn (mirrors chats.cascadeDeleteChat).
    const pending = await ctx.db
      .query("outbox")
      .withIndex("by_status", (q) => q.eq("status", "pending"))
      .collect();
    for (const o of pending) {
      if (o.chatId === chat._id) await ctx.db.delete(o._id);
    }

    // Assistant delete -> regenerate the now-last user message (if any): build a
    // fresh outbox from that user turn (text + its file attachments). dispatchReset
    // runs it AFTER the gateway reset, so it re-hydrates the truncated history.
    let regenerateOutboxId: Id<"outbox"> | undefined;
    if (wasAssistant) {
      const remaining = await ctx.db
        .query("messages")
        .withIndex("by_chat", (q) => q.eq("chatId", chat._id))
        .order("desc")
        .take(1);
      const lastUser = remaining[0];
      if (lastUser && lastUser.role === "user") {
        const partDocs = await ctx.db
          .query("messageParts")
          .withIndex("by_message", (q) => q.eq("messageId", lastUser._id))
          .collect();
        const attachments: {
          storageId: Id<"_storage">;
          filename: string;
          mimeType: string;
        }[] = [];
        for (const d of partDocs) {
          if (d.part.kind === "file") {
            attachments.push({
              storageId: d.part.storageId,
              filename: d.part.filename,
              mimeType: d.part.mimeType,
            });
          }
        }
        regenerateOutboxId = await ctx.db.insert("outbox", {
          chatId: chat._id,
          userId,
          // Unique key (Date.now() is deterministic in a mutation) so the send
          // idempotency guard never dedupes a regenerate against the original.
          clientMessageId: `regen-${lastUser._id}-${Date.now()}`,
          messageId: lastUser._id,
          text: lastUser.text,
          attachmentIds: attachments.map((a) => a.storageId),
          attachments,
          status: "pending",
        });
      }
    }

    // ALWAYS realign the gateway. For the regenerate case dispatchReset chains the
    // re-dispatch AFTER a successful reset (so it runs on the fresh, re-hydrating
    // session — never on the stale one).
    await ctx.scheduler.runAfter(0, internal.bridge.dispatchReset, {
      chatId: chat._id,
      userId,
      ...(regenerateOutboxId ? { regenerateOutboxId } : {}),
    });

    await ctx.db.patch(chat._id, { updatedAt: Date.now() });
    await auditImpersonated(ctx, actor, "message.delete", {
      resource: "message",
      resourceId: messageId,
    });
  },
});
