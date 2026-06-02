// Convex ingest endpoint for the bridge worker (server -> Convex).
//
// WHY THIS EXISTS: the streaming writes live in `internal.stream.*`
// (internalMutation), which the browser CANNOT call and which the public
// ConvexHttpClient cannot call either (admin auth is a private CLI-only path).
// The supported pattern is an authenticated httpAction that holds a secret and
// runs the internal mutations via `ctx.runMutation`. The bridge POSTs one JSON
// `op` per normalized event to `POST /bridge/ingest`.
//
// SECURITY (load-bearing):
//   - `Authorization: Bearer <BRIDGE_INGEST_SECRET>` — the secret is read from
//     DEPLOYMENT ENV (`npx convex env set BRIDGE_INGEST_SECRET ...`), NEVER from
//     a table or the browser. Constant-time compared.
//   - The route is registered in http.ts. Served at the deployment's `.site`
//     origin (NOT the `.cloud` query origin).
//
// NOTE: this file (and the http.ts route) is NOT exercised by the bridge's
// offline tsc/vitest gate (bridge/tsconfig only includes bridge/src + test). It
// is validated by `npx convex dev` / a live deployment.

import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";

// NOTE: this file exports an httpAction only. httpActions run in the DEFAULT
// Convex runtime (fetch + ctx.storage are available; Node built-ins are NOT).
// The secret compare is therefore a pure-JS constant-time comparison over
// UTF-8 bytes — deliberately NOT node:crypto.timingSafeEqual.
function constantTimeEqual(a: string, b: string): boolean {
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  // Compare against a fixed-length accumulator so the loop count does not vary
  // with where the first mismatch is. A length difference is folded into diff.
  const len = Math.max(ab.length, bb.length);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < len; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

// Mirror of bridge/src/convex-writer.ts IngestOp (kept in sync by hand; the
// bridge owns the canonical shape).
type IngestOp =
  | { op: "startAssistant"; chatId: string; runId: string | null }
  | { op: "appendDelta"; messageId: string; text: string }
  | { op: "setSnapshot"; messageId: string; text: string }
  | { op: "addPart"; messageId: string; part: Record<string, unknown> }
  | {
      op: "addMedia";
      messageId: string;
      filename: string;
      path: string;
      mimeType: string | null;
    }
  | {
      op: "finalize";
      messageId: string;
      status: "complete" | "error" | "aborted";
      text: string;
      error: string | null;
    };

export const ingest = httpAction(async (ctx, request) => {
  const secret = process.env.BRIDGE_INGEST_SECRET ?? "";
  const header = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  if (!secret || !constantTimeEqual(header, expected)) {
    return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  let body: IngestOp;
  try {
    body = (await request.json()) as IngestOp;
  } catch {
    return new Response(JSON.stringify({ ok: false, error: "invalid body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  switch (body.op) {
    case "startAssistant": {
      const messageId = await ctx.runMutation(internal.stream.startAssistant, {
        chatId: body.chatId as Id<"chats">,
        runId: body.runId ?? undefined,
      });
      return json({ messageId });
    }
    case "appendDelta": {
      await ctx.runMutation(internal.stream.appendDelta, {
        messageId: body.messageId as Id<"messages">,
        text: body.text,
      });
      return json({ ok: true });
    }
    case "setSnapshot": {
      await ctx.runMutation(internal.stream.setSnapshot, {
        messageId: body.messageId as Id<"messages">,
        text: body.text,
      });
      return json({ ok: true });
    }
    case "addPart": {
      await ctx.runMutation(internal.stream.addPart, {
        messageId: body.messageId as Id<"messages">,
        // The bridge only sends tool/reasoning parts through `addPart`; media
        // goes through `addMedia` (needs a storage round-trip).
        part: body.part as never,
      });
      return json({ ok: true });
    }
    case "addMedia": {
      // Fetch the bytes from the OpenClaw media origin and store them in Convex
      // storage, then insert the media part. OPENCLAW_MEDIA_BASE_URL is set on
      // the deployment env; `path` is the outbound absolute path the normalizer
      // surfaced (already validated against traversal).
      const base = (process.env.OPENCLAW_MEDIA_BASE_URL ?? "").replace(/\/$/, "");
      if (!base) {
        return json({ ok: false, error: "media not configured" }, 500);
      }
      const res = await fetch(`${base}${body.path}`);
      if (!res.ok) {
        return json({ ok: false, error: `media fetch ${res.status}` }, 502);
      }
      const mimeType =
        body.mimeType ?? res.headers.get("content-type") ?? "application/octet-stream";
      const blob = await res.blob();
      const storageId = await ctx.storage.store(blob);
      await ctx.runMutation(internal.stream.addPart, {
        messageId: body.messageId as Id<"messages">,
        part: { kind: "media", storageId, filename: body.filename, mimeType },
      });
      return json({ ok: true });
    }
    case "finalize": {
      await ctx.runMutation(internal.stream.finalize, {
        messageId: body.messageId as Id<"messages">,
        status: body.status,
        text: body.text,
        error: body.error ?? undefined,
      });
      return json({ ok: true });
    }
    default:
      return json({ ok: false, error: "unknown op" }, 400);
  }
});

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
