// Inbound HTTP endpoint: Convex -> bridge.
//
// `convex/bridge.ts` dispatch POSTs a pending user turn to `POST /send`. The
// request shape and auth are DICTATED by convex/bridge.ts (source of truth):
//   headers: { Authorization: <BRIDGE_SHARED_SECRET> }   // raw, NO "Bearer "
//   body:    { chatId, openclawChatId, text, clientMessageId, attachments }
//
// On a valid request we:
//   1. resolve (or lazily create) the per-session OpenClaw connection + run
//      manager for `openclawChatId`,
//   2. patch verboseLevel=full once per connection (sticky server-side),
//   3. chat.send with an idempotencyKey derived from clientMessageId,
//   4. learn the ack runId and beginTurn() so the normalizer admits this run.
//
// SECURITY: the shared secret is compared in CONSTANT TIME; the body is size-
// limited before parsing. We never echo gateway/filesystem detail to the caller.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";

import type { BridgeConfig } from "./config.js";
import { idempotencyKey } from "./openclaw-client.js";
import type { SessionRegistry, BridgeSession } from "./session.js";

interface SendBody {
  chatId: string;
  openclawChatId: string | null;
  text: string;
  clientMessageId: string;
  attachments?: unknown;
}

/** Constant-time string compare that does not leak length via early return. */
function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) {
    // Still run a comparison to avoid trivially leaking the length difference.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/** Read the request body up to `maxBytes`, rejecting anything larger. */
function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(payload);
}

function parseSendBody(raw: string): SendBody | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.chatId !== "string" || typeof obj.text !== "string") {
    return null;
  }
  if (typeof obj.clientMessageId !== "string") {
    return null;
  }
  return {
    chatId: obj.chatId,
    openclawChatId: typeof obj.openclawChatId === "string" ? obj.openclawChatId : null,
    text: obj.text,
    clientMessageId: obj.clientMessageId,
    attachments: obj.attachments,
  };
}

function extractRunId(response: {
  payload?: Record<string, unknown>;
  runId?: unknown;
}): string | null {
  const payload = response.payload;
  if (payload && typeof payload.runId === "string" && payload.runId) {
    return payload.runId;
  }
  if (typeof response.runId === "string" && response.runId) {
    return response.runId;
  }
  return null;
}

/**
 * Perform the send against OpenClaw and begin the assistant turn.
 *
 * Mirrors backend/app/main.py `_send_chat_message` + `_handle_send`:
 * verboseLevel=full once per connection, then chat.send, then note_run_started.
 */
async function performSend(session: BridgeSession, body: SendBody): Promise<void> {
  const conn = session.connection;
  const sessionKey = session.sessionKey;
  if (!conn.verboseFullApplied) {
    await conn.request(
      "sessions.patch",
      { key: sessionKey, verboseLevel: "full" },
      10_000,
    );
    conn.verboseFullApplied = true;
  }
  const params: Record<string, unknown> = {
    sessionKey,
    message: body.text,
    idempotencyKey: await idempotencyKey(sessionKey, body.clientMessageId),
  };
  if (Array.isArray(body.attachments) && body.attachments.length > 0) {
    params.attachments = body.attachments;
  }
  const now = session.clock();
  // Reset the normalizer for this turn BEFORE the ack so frames arriving before
  // the ack are admitted on sessionKey alone (ownRunIds empty), then seed.
  const response = await conn.request("chat.send", params, 20_000);
  const ackRunId = extractRunId(response);
  await session.runManager.beginTurn(now, ackRunId);
}

export interface BridgeServerDeps {
  config: BridgeConfig;
  registry: SessionRegistry;
}

/**
 * Create (but do not start) the inbound HTTP server. Call `.listen(port)`.
 *
 * Routes:
 *   GET  /health  -> liveness probe (no auth)
 *   POST /send    -> authenticated turn dispatch from Convex
 */
export function createBridgeServer(deps: BridgeServerDeps): Server {
  const { config, registry } = deps;
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res).catch((err: unknown) => {
      // Never leave the dispatcher hanging; never leak gateway detail.
      console.error("bridge server error:", (err as Error)?.message ?? err);
      if (!res.headersSent) {
        sendJson(res, 500, { ok: false, error: "internal error" });
      }
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === "GET" && req.url === "/health") {
      sendJson(res, 200, { status: "ok" });
      return;
    }
    if (req.method !== "POST" || req.url !== "/send") {
      sendJson(res, 404, { ok: false, error: "not found" });
      return;
    }

    // Auth: convex/bridge.ts sends the secret RAW in Authorization (no Bearer).
    const provided = req.headers["authorization"];
    if (typeof provided !== "string" || !constantTimeEqual(provided, config.bridgeSharedSecret)) {
      sendJson(res, 401, { ok: false, error: "unauthorized" });
      return;
    }

    let raw: string;
    try {
      raw = await readBody(req, config.maxBodyBytes);
    } catch {
      sendJson(res, 413, { ok: false, error: "payload too large" });
      return;
    }

    const body = parseSendBody(raw);
    if (body === null) {
      sendJson(res, 400, { ok: false, error: "invalid body" });
      return;
    }

    try {
      const session = await registry.acquire(body.chatId, body.openclawChatId);
      await performSend(session, body);
      sendJson(res, 200, { ok: true });
    } catch (err) {
      // A per-send upstream failure is reported but does not crash the bridge.
      console.error("bridge /send failed:", (err as Error)?.message ?? err);
      sendJson(res, 502, { ok: false, error: "upstream send failed" });
    }
  }
}
