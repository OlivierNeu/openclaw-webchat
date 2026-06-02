// Maps normalized bridge events onto the INTERNAL Convex stream mutations.
//
// Why an HTTP ingest endpoint and NOT a deploy-key client:
//   `internal.stream.*` are internalMutations — not callable from a browser and
//   not callable from the public `ConvexHttpClient` (admin auth is a private,
//   untyped CLI-only path). The supported server->Convex pattern is to POST to
//   an authenticated httpAction that holds the secret and runs the internal
//   mutations via `ctx.runMutation`. The bridge therefore speaks to ONE Convex
//   ingest endpoint (convex/bridge_ingest.ts) with a Bearer secret.
//
// The `ConvexWriter` INTERFACE is the load-bearing seam: run-manager depends on
// it, the live HTTP writer implements it, and the test substitutes a fake that
// records the calls. Keeping media resolution behind the interface means the
// fake records `addMedia` without touching the filesystem or Convex storage.

/** Mirrors convex/schema.ts messagePart `tool` variant. */
export interface ToolPart {
  kind: "tool";
  name: string;
  phase: string;
  input?: unknown;
  output?: unknown;
}

/** Mirrors convex/schema.ts messagePart `reasoning` variant. */
export interface ReasoningPart {
  kind: "reasoning";
  text: string;
}

export type FinalizeStatus = "complete" | "error" | "aborted";

/**
 * The seam between the run-manager and Convex. Each method maps 1:1 onto an
 * internal stream mutation (see convex/stream.ts). All calls MUST be awaited in
 * order by the run-manager so appendDelta ordering is deterministic.
 */
export interface ConvexWriter {
  /** run start -> internal.stream.startAssistant; returns the new message id. */
  startAssistant(chatId: string, runId: string | null): Promise<string>;
  /** message.delta -> internal.stream.appendDelta. */
  appendDelta(messageId: string, text: string): Promise<void>;
  /** message.snapshot -> internal.stream.setSnapshot. */
  setSnapshot(messageId: string, text: string): Promise<void>;
  /** tool.status -> internal.stream.addPart(kind:tool). */
  addToolPart(messageId: string, part: ToolPart): Promise<void>;
  /**
   * media -> fetch bytes for `path`, store in Convex storage, then
   * internal.stream.addPart(kind:media,storageId). Resolution is behind the
   * interface so the fake can record it without I/O.
   */
  addMedia(
    messageId: string,
    media: { filename: string; path: string; mimeType?: string },
  ): Promise<void>;
  /** message.final -> internal.stream.finalize. */
  finalize(
    messageId: string,
    status: FinalizeStatus,
    text: string,
    error: string | null,
  ): Promise<void>;
}

/** Operations the Convex ingest httpAction understands (its JSON `op` field). */
type IngestOp =
  | { op: "startAssistant"; chatId: string; runId: string | null }
  | { op: "appendDelta"; messageId: string; text: string }
  | { op: "setSnapshot"; messageId: string; text: string }
  | { op: "addPart"; messageId: string; part: ToolPart }
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
      status: FinalizeStatus;
      text: string;
      error: string | null;
    };

export interface HttpConvexWriterOptions {
  /** Convex httpActions base URL (the `.site` origin). */
  convexHttpActionsUrl: string;
  /** Bearer secret presented to the ingest endpoint. */
  ingestSecret: string;
  /** Coalesce window for deltas in ms (one mutation per flush, not per token). */
  deltaFlushMs?: number;
  /** Injected fetch (defaults to global fetch); lets tests stub the network. */
  fetchImpl?: typeof fetch;
}

const INGEST_PATH = "/bridge/ingest";

/**
 * Live writer that POSTs each op to the Convex ingest httpAction.
 *
 * Delta coalescing: rather than one `appendDelta` mutation per streamed token,
 * deltas are buffered per message and flushed every `deltaFlushMs` (~50ms) or
 * immediately before any non-delta op (snapshot/part/finalize) so ordering is
 * preserved relative to the rest of the stream.
 */
export class HttpConvexWriter implements ConvexWriter {
  private readonly url: string;
  private readonly ingestSecret: string;
  private readonly deltaFlushMs: number;
  private readonly fetchImpl: typeof fetch;

  // Per-message pending delta buffer + its flush timer.
  private pendingDelta = new Map<string, string>();
  private flushTimer = new Map<string, NodeJS.Timeout>();
  // Serialization chain: every op POSTs strictly in enqueue order, so a flush
  // timer firing concurrently with a snapshot/finalize never scrambles ordering
  // (the ingest mutations are sequential per message and order is load-bearing).
  private chain: Promise<unknown> = Promise.resolve();

  constructor(opts: HttpConvexWriterOptions) {
    this.url = opts.convexHttpActionsUrl.replace(/\/$/, "") + INGEST_PATH;
    this.ingestSecret = opts.ingestSecret;
    this.deltaFlushMs = opts.deltaFlushMs ?? 50;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** Enqueue an op on the serialization chain; resolves with its result. */
  private post<T>(body: IngestOp): Promise<T> {
    const run = this.chain.then(() => this.doPost<T>(body));
    // Keep the chain alive even if this op rejects (don't poison later ops),
    // but propagate the error to the caller via `run`.
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async doPost<T>(body: IngestOp): Promise<T> {
    const response = await this.fetchImpl(this.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.ingestSecret}`,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `Convex ingest ${body.op} -> HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
      );
    }
    return (await response.json()) as T;
  }

  async startAssistant(chatId: string, runId: string | null): Promise<string> {
    const { messageId } = await this.post<{ messageId: string }>({
      op: "startAssistant",
      chatId,
      runId,
    });
    return messageId;
  }

  async appendDelta(messageId: string, text: string): Promise<void> {
    const buffered = (this.pendingDelta.get(messageId) ?? "") + text;
    this.pendingDelta.set(messageId, buffered);
    if (this.flushTimer.has(messageId)) {
      return; // a flush is already scheduled
    }
    const timer = setTimeout(() => {
      void this.flushDelta(messageId);
    }, this.deltaFlushMs);
    // Do not keep the process alive solely for a pending flush.
    if (typeof timer.unref === "function") {
      timer.unref();
    }
    this.flushTimer.set(messageId, timer);
  }

  /** Flush the coalesced delta buffer for a message as a single appendDelta. */
  private async flushDelta(messageId: string): Promise<void> {
    const timer = this.flushTimer.get(messageId);
    if (timer) {
      clearTimeout(timer);
      this.flushTimer.delete(messageId);
    }
    const text = this.pendingDelta.get(messageId);
    if (text === undefined || text === "") {
      this.pendingDelta.delete(messageId);
      return;
    }
    this.pendingDelta.delete(messageId);
    await this.post({ op: "appendDelta", messageId, text });
  }

  async setSnapshot(messageId: string, text: string): Promise<void> {
    await this.flushDelta(messageId); // ordering: drain deltas first
    await this.post({ op: "setSnapshot", messageId, text });
  }

  async addToolPart(messageId: string, part: ToolPart): Promise<void> {
    await this.flushDelta(messageId);
    await this.post({ op: "addPart", messageId, part });
  }

  async addMedia(
    messageId: string,
    media: { filename: string; path: string; mimeType?: string },
  ): Promise<void> {
    await this.flushDelta(messageId);
    // The ingest httpAction fetches the bytes for `path` and stores them in
    // Convex storage (it holds the OpenClaw media credentials), then inserts a
    // media part. The bridge never sees a signed URL.
    await this.post({
      op: "addMedia",
      messageId,
      filename: media.filename,
      path: media.path,
      mimeType: media.mimeType ?? null,
    });
  }

  async finalize(
    messageId: string,
    status: FinalizeStatus,
    text: string,
    error: string | null,
  ): Promise<void> {
    await this.flushDelta(messageId); // never strand buffered deltas behind final
    await this.post({ op: "finalize", messageId, status, text, error });
  }
}
