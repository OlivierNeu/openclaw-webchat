// Per-session run tracking: wires the proven Normalizer to a ConvexWriter.
//
// One RunManager instance handles one OpenClaw session (one chat). It owns a
// Normalizer (begin_turn/feed/tick/next_timeout) and translates the stable
// bridge events the normalizer emits into ordered ConvexWriter calls.
//
// Event -> writer mapping (see convex/stream.ts + normalizer event shapes):
//   turn begin            -> startAssistant(chatId, ackRunId)  [once, returns messageId]
//   message.delta {text}  -> appendDelta(messageId, text)
//   message.snapshot{text}-> setSnapshot(messageId, text)
//   tool.status {name,phase} -> addPart(kind:tool)
//   media {items[]}       -> addMedia per item (writer stores bytes)
//   message.final {text,error?} + paired run.status {status} -> finalize(...)
//   intermediate run.status (working/running/compacting) -> dropped (no schema fit)
//
// finalize semantics (load-bearing): normalizer.finalize() emits the PAIR
// [message.final{text,error?}, run.status{status}]. message.final alone cannot
// distinguish complete vs aborted (aborted carries no error). So we BUFFER the
// final text/error from message.final and emit the writer.finalize() only when
// the paired terminal run.status arrives, mapping
//   final  -> complete
//   error  -> error
//   aborted-> aborted
// Every other run.status is intermediate and dropped.

import { Normalizer, type BridgeEvent } from "./normalizer.js";
import type { ConvexWriter, FinalizeStatus, ToolPart } from "./convex-writer.js";

const TERMINAL_STATUS: Record<string, FinalizeStatus> = {
  final: "complete",
  complete: "complete",
  error: "error",
  aborted: "aborted",
};

interface MediaItem {
  filename: string;
  path: string;
}

/**
 * Drives one OpenClaw session's normalized stream into Convex.
 *
 * Lifecycle per user turn:
 *   1. beginTurn(): reset normalizer state, create the streaming assistant
 *      message (startAssistant), seed ownRunIds from the chat.send ack runId.
 *   2. feed each inbound gateway frame; tick on the normalizer's timeout.
 *   3. the normalizer emits the terminal [message.final, run.status] pair which
 *      we translate into a single writer.finalize().
 */
export class RunManager {
  private readonly chatId: string;
  private readonly normalizer: Normalizer;
  private readonly writer: ConvexWriter;

  private messageId: string | null = null;
  private turnActive = false;
  // Buffered final from message.final, applied when the paired run.status lands.
  private pendingFinalText = "";
  private pendingFinalError: string | null = null;
  private hasPendingFinal = false;

  constructor(chatId: string, sessionKey: string, writer: ConvexWriter) {
    this.chatId = chatId;
    this.normalizer = new Normalizer(sessionKey);
    this.writer = writer;
  }

  /** Seconds until the normalizer's nearest deadline (null = idle). */
  nextTimeout(now: number): number | null {
    return this.normalizer.nextTimeout(now);
  }

  get isFinalized(): boolean {
    return this.normalizer.finalized;
  }

  /**
   * Start a new assistant turn. Creates the streaming message in Convex and
   * seeds ownRunIds from the chat.send ack runId (foreign-run isolation). Call
   * before feeding any frames for the turn.
   */
  async beginTurn(now: number, ackRunId: string | null): Promise<void> {
    this.normalizer.beginTurn(now);
    if (ackRunId) {
      this.normalizer.noteRunStarted(ackRunId, now);
    }
    this.pendingFinalText = "";
    this.pendingFinalError = null;
    this.hasPendingFinal = false;
    this.turnActive = true;
    // Create the streaming assistant message up-front (run.status begin is not
    // guaranteed before content; chat-final-content has none until the end).
    this.messageId = await this.writer.startAssistant(this.chatId, ackRunId);
  }

  /** Feed one raw gateway frame; apply the resulting events to Convex. */
  async feed(frame: unknown, now: number): Promise<void> {
    if (!this.turnActive) {
      return;
    }
    await this.apply(this.normalizer.feed(frame, now));
  }

  /** Resolve expired normalizer deadlines; apply any emitted events. */
  async tick(now: number): Promise<void> {
    if (!this.turnActive) {
      return;
    }
    await this.apply(this.normalizer.tick(now));
  }

  /**
   * Force-finalize the active turn (e.g. on socket close or a send error). The
   * normalizer emits its terminal pair; we flush it to Convex.
   */
  async endTurn(now: number, status = "final", error: string | null = null): Promise<void> {
    if (!this.turnActive) {
      return;
    }
    await this.apply(this.normalizer.endTurn(now, status, error));
  }

  /** Apply a batch of normalizer events to the writer, strictly in order. */
  private async apply(events: BridgeEvent[]): Promise<void> {
    const messageId = this.messageId;
    if (messageId === null) {
      return; // beginTurn not called: nothing to write to
    }
    for (const event of events) {
      switch (event.type) {
        case "message.delta": {
          const text = asString(event.text);
          if (text) {
            await this.writer.appendDelta(messageId, text);
          }
          break;
        }
        case "message.snapshot": {
          await this.writer.setSnapshot(messageId, asString(event.text));
          break;
        }
        case "tool.status": {
          const part: ToolPart = {
            kind: "tool",
            name: asString(event.name),
            phase: asString(event.phase),
          };
          await this.writer.addToolPart(messageId, part);
          break;
        }
        case "media": {
          for (const item of mediaItems(event.items)) {
            await this.writer.addMedia(messageId, {
              filename: item.filename,
              path: item.path,
            });
          }
          break;
        }
        case "message.final": {
          // Buffer; the paired run.status decides complete vs error vs aborted.
          this.pendingFinalText = asString(event.text);
          this.pendingFinalError =
            event.error === undefined || event.error === null
              ? null
              : String(event.error);
          this.hasPendingFinal = true;
          break;
        }
        case "run.status": {
          const status = asString(event.status);
          const mapped = TERMINAL_STATUS[status];
          if (mapped !== undefined) {
            await this.flushFinal(mapped);
          }
          // Intermediate statuses (working/running/compacting) have no schema
          // representation -> dropped.
          break;
        }
        case "openclaw.frame":
        default:
          // Deprecated raw passthrough / unknown -> not persisted.
          break;
      }
    }
  }

  /** Emit the buffered final via writer.finalize(); ends the turn. */
  private async flushFinal(status: FinalizeStatus): Promise<void> {
    const messageId = this.messageId;
    if (messageId === null || !this.turnActive) {
      return;
    }
    this.turnActive = false;
    // The error string (if any) was buffered from message.final; on a clean
    // turn it is null. lifecycle:error finalizes with both partial text + error.
    await this.writer.finalize(
      messageId,
      status,
      this.hasPendingFinal ? this.pendingFinalText : "",
      this.pendingFinalError,
    );
  }
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function mediaItems(value: unknown): MediaItem[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const items: MediaItem[] = [];
  for (const raw of value) {
    if (
      typeof raw === "object" &&
      raw !== null &&
      typeof (raw as Record<string, unknown>).filename === "string" &&
      typeof (raw as Record<string, unknown>).path === "string"
    ) {
      const obj = raw as { filename: string; path: string };
      items.push({ filename: obj.filename, path: obj.path });
    }
  }
  return items;
}
