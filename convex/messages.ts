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
import { query } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { requireOwnedChat, requireUserId } from "./lib/access";

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
  args: { chatId: v.id("chats") },
  handler: async (ctx, { chatId }) => {
    const userId = await requireUserId(ctx);
    // Ownership check — throws if the user does not own this chat.
    await requireOwnedChat(ctx, userId, chatId);

    // Bounded read: most-recent MESSAGE_WINDOW messages, newest first.
    const recentDesc = await ctx.db
      .query("messages")
      .withIndex("by_chat", (q) => q.eq("chatId", chatId))
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
          _creationTime: message._creationTime,
          role: message.role,
          status: message.status,
          runId: message.runId,
          text: message.text,
          error: message.error,
          updatedAt: message.updatedAt,
          parts,
        };
      }),
    );

    return result;
  },
});

// Optional: list the chats owned by the authenticated user (sidebar). Scoped.
export const listChats = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    const chats = await ctx.db
      .query("chats")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    chats.sort((a, b) => b.updatedAt - a.updatedAt);
    return chats
      .filter((c) => !c.archived)
      .map((c) => ({
        _id: c._id as Id<"chats">,
        title: c.title,
        updatedAt: c.updatedAt,
      }));
  },
});
