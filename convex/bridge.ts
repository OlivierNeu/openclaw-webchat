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
  ActionCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { getProfile } from "./lib/access";
import { resolveTargetForProfile } from "./routing";

/**
 * ArrayBuffer -> base64 in the DEFAULT Convex action runtime (no Node Buffer;
 * `btoa` is available). Chunked so a multi-MB attachment doesn't blow the call
 * stack on `String.fromCharCode(...spread)`.
 */
function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Emit an outbound `openclaw.dispatch` trace via the `recordEvent`
 * internalMutation (an action has no `ctx.db`). D2: metadata only — never the
 * outbox text, attachment contents, or gateway tokens. Target instance/agent
 * NAMES are non-secret (the bridge maps them to tokens) and may be logged.
 * Wrapped so a trace failure can NEVER affect the dispatch outcome.
 */
async function traceDispatch(
  ctx: ActionCtx,
  args: {
    outboxId: Id<"outbox">;
    chatId?: string;
    dispatchStatus: "sent" | "failed";
    target?: { instanceName?: string; agentId?: string };
    reason?: string;
  },
): Promise<void> {
  try {
    await ctx.runMutation(internal.observability.recordEvent, {
      kind: "openclaw.dispatch",
      direction: "outbound",
      principalType: "system",
      principalId: "bridge",
      chatId: args.chatId,
      correlationId: args.chatId
        ? `${args.chatId}:${args.outboxId}`
        : `${args.outboxId}`,
      meta: JSON.stringify({
        outboxId: args.outboxId,
        // String lifecycle status lives in meta (the `status` column is numeric).
        dispatchStatus: args.dispatchStatus,
        instanceName: args.target?.instanceName,
        agentId: args.target?.agentId,
        ...(args.reason ? { reason: args.reason } : {}),
      }),
    });
  } catch {
    // Best-effort: never break the dispatch flow on a trace error.
  }
}

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

// Resolve routing for an outbox row's owner: the OpenClaw chat id (non-secret
// thread id) PLUS the resolved instance/agent target from the valves. The
// bridge maps instanceName -> token/deviceIdentity from its env; only names
// cross this boundary, never secrets.
export const getChatRouting = internalQuery({
  args: { chatId: v.id("chats"), userId: v.id("users") },
  handler: async (ctx, { chatId, userId }) => {
    const chat = await ctx.db.get(chatId);
    if (chat === null) {
      return null;
    }
    const profile = await getProfile(ctx, userId);
    const target = await resolveTargetForProfile(ctx, profile);
    return {
      openclawChatId: chat.openclawChatId ?? null,
      // null target => the user is unrouted (no override, no group); the
      // dispatch will mark the row failed rather than send to a wrong agent.
      target,
      // The user's per-chat OpenClaw knob intent (reasoning/model). The bridge
      // re-applies these via sessions.patch before each turn so they survive a
      // session reset. Non-secret labels only.
      sessionSettings: chat.sessionSettings ?? null,
    };
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
      await traceDispatch(ctx, {
        outboxId,
        chatId: row.chatId,
        dispatchStatus: "failed",
        reason: "not_configured",
      });
      return;
    }

    const routing = await ctx.runQuery(internal.bridge.getChatRouting, {
      chatId: row.chatId as Id<"chats">,
      userId: row.userId as Id<"users">,
    });

    // Unrouted user (no override, no group) -> cannot pick an agent. Mark failed
    // rather than send to a wrong/absent target.
    if (!routing || routing.target === null) {
      console.error("bridge.dispatch: user is unrouted (no valve target)");
      await ctx.runMutation(internal.bridge.markOutbox, {
        outboxId,
        status: "failed",
      });
      await traceDispatch(ctx, {
        outboxId,
        chatId: row.chatId,
        dispatchStatus: "failed",
        reason: "unrouted",
      });
      return;
    }

    // Resolve INBOUND attachments (storageId -> bytes -> base64) into OpenClaw's
    // chat.send.attachment shape. Inbound rides the JSON WS, so it MUST be inline
    // base64 (the gateway offloads it to media://inbound); bounded by the WS
    // maxPayload (~25 MiB). Unreadable / over-cap blobs are skipped (logged) so a
    // bad attachment never fails the text send.
    const INBOUND_MAX_BYTES = 20 * 1024 * 1024;
    const resolvedAttachments: Array<{
      type: string;
      mimeType: string;
      fileName: string;
      content: string;
    }> = [];
    for (const a of row.attachments ?? []) {
      try {
        const blob = await ctx.storage.get(a.storageId);
        if (blob === null) continue;
        if (blob.size > INBOUND_MAX_BYTES) {
          console.error(
            `bridge.dispatch: inbound attachment too large (${blob.size} bytes) — skipped`,
          );
          continue;
        }
        resolvedAttachments.push({
          type: "file",
          mimeType: a.mimeType || blob.type || "application/octet-stream",
          fileName: a.filename,
          content: arrayBufferToBase64(await blob.arrayBuffer()),
        });
      } catch (err) {
        console.error("bridge.dispatch: attachment resolve failed:", err);
      }
    }

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
          openclawChatId: routing.openclawChatId,
          // Resolved valve target (non-secret names): the bridge maps
          // instanceName -> gateway token/device identity from its env.
          instanceName: routing.target.instanceName,
          agentId: routing.target.agentId,
          canonical: routing.target.canonical,
          text: row.text,
          clientMessageId: row.clientMessageId,
          // The user message id for THIS turn — the bridge excludes it when it
          // fetches prior history for session re-hydration (so the current
          // message is not duplicated into the injected context).
          messageId: row.messageId ?? null,
          // Per-chat knob intent: the bridge re-applies these (sessions.patch)
          // before chat.send so a reset session keeps the user's reasoning/model.
          sessionSettings: routing.sessionSettings,
          attachments: resolvedAttachments,
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
    await traceDispatch(ctx, {
      outboxId,
      chatId: row.chatId,
      dispatchStatus: ok ? "sent" : "failed",
      // Non-secret valve target names (instanceName -> token mapping is the
      // bridge's job; only names cross this boundary).
      target: {
        instanceName: routing.target.instanceName,
        agentId: routing.target.agentId,
      },
    });
  },
});

/**
 * Immediate write-back of a per-chat OpenClaw knob (reasoning level / model).
 * Scheduled by `chats.setSessionKnob` after it persists `sessionSettings`. POSTs
 * the current intent to the bridge's `POST /patch`, which calls `sessions.patch`
 * then re-describes + reports the CONFIRMED live `sessionMeta` back (so the chip
 * is honest, never optimistic). Best-effort: a missing config / unrouted user /
 * bridge error is logged and traced but never throws (a thrown action is retried
 * by Convex). The chip simply does not move if the patch did not land.
 */
export const dispatchPatch = internalAction({
  args: { chatId: v.id("chats"), userId: v.id("users") },
  handler: async (ctx, { chatId, userId }) => {
    const bridgeUrl = process.env.BRIDGE_URL;
    const sharedSecret = process.env.BRIDGE_SHARED_SECRET;
    if (!bridgeUrl || !sharedSecret) {
      console.error(
        "bridge.dispatchPatch: BRIDGE_URL / BRIDGE_SHARED_SECRET not configured",
      );
      return;
    }

    const routing = await ctx.runQuery(internal.bridge.getChatRouting, {
      chatId,
      userId,
    });
    if (!routing || routing.target === null) {
      console.error("bridge.dispatchPatch: user is unrouted (no valve target)");
      return;
    }
    const settings = routing.sessionSettings;
    if (!settings || (settings.thinkingLevel == null && settings.model == null)) {
      return; // nothing to apply
    }

    let ok = false;
    try {
      const response = await fetch(`${bridgeUrl.replace(/\/$/, "")}/patch`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: sharedSecret,
        },
        body: JSON.stringify({
          chatId,
          openclawChatId: routing.openclawChatId,
          instanceName: routing.target.instanceName,
          agentId: routing.target.agentId,
          canonical: routing.target.canonical,
          thinkingLevel: settings.thinkingLevel ?? null,
          model: settings.model ?? null,
        }),
      });
      ok = response.ok;
      if (!ok) {
        console.error(`bridge POST /patch -> HTTP ${response.status}`);
      }
    } catch (err) {
      console.error("bridge POST /patch failed:", err);
      ok = false;
    }

    // Trace the knob write-back (metadata only — knob NAMES are non-secret; never
    // tokens). Wrapped so a trace failure can never affect the outcome.
    try {
      await ctx.runMutation(internal.observability.recordEvent, {
        kind: "openclaw.patch",
        direction: "outbound",
        principalType: "user",
        principalId: userId,
        chatId,
        correlationId: `${chatId}:patch`,
        meta: JSON.stringify({
          patchStatus: ok ? "sent" : "failed",
          thinkingLevel: settings.thinkingLevel,
          model: settings.model,
          instanceName: routing.target.instanceName,
          agentId: routing.target.agentId,
        }),
      });
    } catch {
      // best-effort
    }
  },
});
