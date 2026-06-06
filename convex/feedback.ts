// On-demand FORENSIC feedback (OpenRouter-style "Report Feedback").
//
// When a user flags a message, `submitFeedback` FREEZES a complete forensic
// snapshot at that instant. This is the project's answer to "OpenClaw modified
// my words": the feedback is the dispute signal, and we capture everything
// needed to analyze it BEFORE a UI-7 delete/regenerate can erase the evidence.
//
// TRUST MODEL (non-negotiable — the whole forensic value rests on it):
//   - `snapshot.messageText` and every other authoritative field are read
//     SERVER-SIDE from the DB here, NEVER accepted from the client. If the
//     client could supply the "stored" text, anyone could forge the proof.
//   - `displayedText` is the ONLY client-declared content: it is what the
//     BROWSER actually rendered (the byte-exact `.oc-msg__source-pre`
//     textContent, or `metadata.custom.rawText`). Its sole purpose is letting
//     the server compute `displayedMatchesStored` — proving whether the browser
//     altered the displayed characters. It is never treated as truth.
//
// SCOPE HONESTY: strong for AI-response disputes (full generating context frozen)
// and for preserving evidence before a delete. For "you changed the words I
// TYPED" the mutation happens BEFORE our first capture point (OS/keyboard
// autocorrect), so no server snapshot can prove the pre-capture state — only the
// input hardening + the byte-exact source view address that case. `clientInfo`
// captures the environment (best available diagnostic), nothing more.

import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { Doc } from "./_generated/dataModel";
import { requireActive, requireOwnedChat } from "./lib/access";
import { recordAudit } from "./lib/audit";

// Allowed report categories (mirrors OpenRouter's set, adapted: `altered_words`
// is added because it is the dispute this whole feature exists to investigate;
// `billing` is dropped — no billing surface yet). Kept as a plain list so the
// frontend and the validator agree on one source of truth.
export const FEEDBACK_CATEGORIES = [
  "incoherence",
  "incorrect",
  "altered_words",
  "formatting",
  "latency",
  "api_error",
  "other",
] as const;
type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number];

const COMMENT_MAX = 1000;
const DISPLAYED_MAX = 100_000; // generous; just a guard against abuse
// Bounded forensic context window. CONTEXT_SCAN bounds how far back we look to
// locate the reported message; CONTEXT_WINDOW is how many turns we actually
// freeze (ending at the reported message). The bound is RECORDED in the snapshot
// (contextWindowLimit/contextTruncated) — never a silent truncation.
const CONTEXT_SCAN = 60;
const CONTEXT_WINDOW = 12;
const PARTS_MAX = 50;

function isCategory(s: string): s is FeedbackCategory {
  return (FEEDBACK_CATEGORIES as readonly string[]).includes(s);
}

function safeJson(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

/**
 * Freeze a forensic snapshot for one message and store it with the user's
 * report. Owner-scoped to the EFFECTIVE identity; audited (the realUserId is
 * always recorded, so a report filed while impersonating is attributable).
 */
export const submitFeedback = mutation({
  args: {
    chatId: v.id("chats"),
    messageId: v.id("messages"),
    category: v.string(),
    comment: v.optional(v.string()),
    // CLIENT DECLARATIONS ONLY (browser-fidelity comparison + environment). Never
    // used as the source of truth for stored content.
    client: v.optional(
      v.object({
        displayedText: v.optional(v.string()),
        sourceWasOpen: v.optional(v.boolean()),
        userAgent: v.optional(v.string()),
        language: v.optional(v.string()),
        timezone: v.optional(v.string()),
        appVersion: v.optional(v.string()),
        theme: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const { userId, realUserId, impersonating, actor } =
      await requireActive(ctx);

    if (!isCategory(args.category)) {
      throw new Error(`Invalid feedback category: ${args.category}`);
    }

    // Owner-scope: both the chat and the message must belong to the effective
    // user. (An admin investigating another user does so via impersonation,
    // which flips the effective identity — and is audited below.)
    await requireOwnedChat(ctx, userId, args.chatId);
    const message = await ctx.db.get(args.messageId);
    if (
      message === null ||
      message.chatId !== args.chatId ||
      message.userId !== userId
    ) {
      throw new Error("Forbidden: message not owned by user");
    }

    // --- SERVER-READ authoritative content (never from the client) ---
    const messageText = message.text;

    // Message structure: tools / reasoning / media parts, ordered, bounded.
    const partDocs = await ctx.db
      .query("messageParts")
      .withIndex("by_message", (q) => q.eq("messageId", message._id))
      .collect();
    partDocs.sort((a, b) => a.order - b.order);
    const partsCount = partDocs.length;
    const partsJson = safeJson(
      partDocs.slice(0, PARTS_MAX).map((p) => p.part),
    );

    // Bounded recent window to locate the message + freeze generating context.
    const recentDesc = await ctx.db
      .query("messages")
      .withIndex("by_chat", (q) => q.eq("chatId", args.chatId))
      .order("desc")
      .take(CONTEXT_SCAN);
    const asc = recentDesc.reverse();
    const idx = asc.findIndex((m) => m._id === message._id);

    let promptMessage: Doc<"messages"> | null = null;
    let contextSlice: Doc<"messages">[] = [];
    let contextTruncated = false;
    if (idx >= 0) {
      const start = Math.max(0, idx - (CONTEXT_WINDOW - 1));
      contextSlice = asc.slice(start, idx + 1);
      contextTruncated = start > 0 || recentDesc.length === CONTEXT_SCAN;
      // Nearest preceding user turn = the prompt that generated this message.
      for (let i = idx - 1; i >= 0; i--) {
        if (asc[i].role === "user") {
          promptMessage = asc[i];
          break;
        }
      }
    } else {
      // Message older than the scan window: freeze just the message itself and
      // record that context was unavailable rather than silently dropping it.
      contextSlice = [message];
      contextTruncated = true;
    }
    const contextJson = safeJson(
      contextSlice.map((m) => ({ role: m.role, text: m.text })),
    );

    // Session config that produced the message.
    const chat = await ctx.db.get(args.chatId);
    const sessionMeta = chat?.sessionMeta;
    const sessionSettings = chat?.sessionSettings;

    // Dispatched payload (best-effort): the outbox row for the relevant USER
    // turn. Transient — usually gone for historical messages; captured when
    // still present. For a user-message report it is the message itself; for an
    // assistant report it is the preceding prompt.
    const outboxKeyMessageId =
      message.role === "user" ? message._id : promptMessage?._id;
    let outbox: Doc<"outbox"> | null = null;
    if (outboxKeyMessageId) {
      outbox = await ctx.db
        .query("outbox")
        .withIndex("by_message", (q) => q.eq("messageId", outboxKeyMessageId))
        .first();
    }

    // CLIENT comparison: did the browser render exactly the stored characters?
    const displayedText = args.client?.displayedText?.slice(0, DISPLAYED_MAX);
    const displayedMatchesStored =
      displayedText === undefined ? undefined : displayedText === messageText;

    const comment = args.comment?.slice(0, COMMENT_MAX) || undefined;

    const feedbackId = await ctx.db.insert("feedback", {
      userId,
      realUserId,
      impersonated: impersonating,
      chatId: args.chatId,
      messageId: args.messageId,
      at: Date.now(),
      category: args.category,
      comment,
      snapshot: {
        messageRole: message.role,
        messageText,
        messageStatus: message.status,
        messageError: message.error,
        messageUpdatedAt: message.updatedAt,
        runId: message.runId,
        isRegeneration: outbox?.clientMessageId?.startsWith("regen-"),
        partsJson,
        partsCount,
        promptMessageId: promptMessage?._id,
        promptText: promptMessage?.text,
        contextJson,
        contextCount: contextSlice.length,
        contextWindowLimit: CONTEXT_WINDOW,
        contextTruncated,
        sessionSettings: sessionSettings
          ? {
              thinkingLevel: sessionSettings.thinkingLevel,
              model: sessionSettings.model,
            }
          : undefined,
        sessionMetaJson: sessionMeta ? safeJson(sessionMeta) : undefined,
        openclawModel: sessionMeta?.model,
        openclawProvider: sessionMeta?.modelProvider,
        openclawRuntime: sessionMeta?.agentRuntime,
        // openclawVersion lives bridge-side; not in Convex today (field reserved).
        openclawVersion: undefined,
        outboxText: outbox?.text,
        outboxStatus: outbox?.status,
        outboxClientMessageId: outbox?.clientMessageId,
        outboxAttachmentsCount: outbox?.attachmentIds.length,
        outboxAvailable: outbox !== null,
        // contentHash deferred (no deterministic sync hash in a mutation; the
        // frozen snapshot is itself the authoritative evidence).
        contentHash: undefined,
        displayedText,
        displayedMatchesStored,
        clientInfo: args.client
          ? {
              userAgent: args.client.userAgent,
              language: args.client.language,
              timezone: args.client.timezone,
              appVersion: args.client.appVersion,
              theme: args.client.theme,
              sourceWasOpen: args.client.sourceWasOpen,
            }
          : undefined,
      },
    });

    // Audit every submission (low volume, forensically useful). recordAudit
    // stores realUserId + the impersonated flag, so a report filed while an
    // admin impersonates a user is fully attributable.
    await recordAudit(ctx, actor, "feedback.submit", {
      resource: "message",
      resourceId: args.messageId,
    });

    return { feedbackId, displayedMatchesStored };
  },
});

/**
 * Message ids in a chat that the EFFECTIVE user has already reported — so the UI
 * can mark the flag as active. Owner-scoped + bounded by the chat's feedback.
 */
export const myReportedMessageIds = query({
  args: { chatId: v.id("chats") },
  handler: async (ctx, { chatId }) => {
    const { userId } = await requireActive(ctx);
    const chat = await ctx.db.get(chatId);
    if (chat === null || chat.userId !== userId) return [];
    const rows = await ctx.db
      .query("feedback")
      .withIndex("by_chat", (q) => q.eq("chatId", chatId))
      .collect();
    return rows
      .filter((r) => r.userId === userId)
      .map((r) => r.messageId as string);
  },
});
