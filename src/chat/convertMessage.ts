import type { ThreadMessageLike } from "@assistant-ui/react";
import {
  ConvexMessagePartView,
  ConvexMessageView,
  isFilePart,
  isMediaPart,
  isReasoningPart,
  isToolPart,
} from "./convexTypes";

// Maps a Convex `messages` document (joined with its ordered `messageParts`)
// into the assistant-ui `ThreadMessageLike` shape consumed by
// useExternalStoreRuntime's `convertMessage`.
//
// Content parts produced:
//   - { type: "text", text }                         (assistant/user/system body)
//   - { type: "tool-call", toolCallId, toolName, args, result }
//   - { type: "file", mimeType, data: <url> }        (media + file parts)
//   - { type: "reasoning", text }                    (reasoning parts)
//
// Streaming works WITHOUT any HTTP transport: the Convex bridge worker patches
// the message doc (text/status) and appends messageParts as OpenClaw frames
// arrive; useQuery re-runs reactively; this converter re-runs; assistant-ui
// re-renders. There is no per-turn POST+SSE connection that could close and
// drop post-turn OpenClaw events (the Open WebUI failure mode this project
// exists to kill).

// ThreadMessageLike["content"] is `string | readonly Part[]` in 0.14, so the
// `extends Array<infer T>` trick resolves to `never`. Take the array element
// type directly via indexed access on the array branch.
type MessageContent = NonNullable<ThreadMessageLike["content"]>;
type ContentPart = Extract<MessageContent, readonly unknown[]>[number];

/** Stable synthetic toolCallId; OpenClaw tool frames are keyed by run + name + order. */
function toolCallId(message: ConvexMessageView, order: number): string {
  const run = message.runId ?? "norun";
  return `${message._id}:${run}:${order}`;
}

function toolPartToContent(
  message: ConvexMessageView,
  order: number,
  part: Extract<ConvexMessagePartView, { kind: "tool" }>,
): ContentPart {
  return {
    type: "tool-call",
    toolCallId: toolCallId(message, order),
    toolName: part.name,
    // assistant-ui expects `args` (parsed input) and `result` (parsed output).
    args: (part.input ?? {}) as Record<string, unknown>,
    result: part.output,
    // `argsText` lets assistant-ui render partial/streaming tool args; we pass
    // the JSON form when available so a tool card can show inputs while running.
    argsText:
      part.input === undefined ? undefined : safeStringify(part.input),
  } as ContentPart;
}

function filePartToContent(
  part:
    | Extract<ConvexMessagePartView, { kind: "media" }>
    | Extract<ConvexMessagePartView, { kind: "file" }>,
): ContentPart | null {
  // Without a resolved URL there is nothing renderable; skip rather than leak
  // a storageId (which is an opaque key, never a path) into the DOM as data.
  if (!part.url) return null;
  return {
    type: "file",
    mimeType: part.mimeType,
    data: part.url,
    // `filename` is non-standard on the file content part but assistant-ui
    // tolerates extra fields and our custom MediaPart renderer reads it.
    filename: part.filename,
  } as ContentPart;
}

function safeStringify(value: unknown): string {
  try {
    return typeof value === "string" ? value : JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function convertConvexMessage(
  message: ConvexMessageView,
): ThreadMessageLike {
  const content: ContentPart[] = [];

  // 1) Primary text body. `message.text` is the live-streamed/normalized text
  //    (message.delta appends, message.snapshot replaces, message.final fixes).
  //    Always include it (even empty) so an in-flight assistant bubble renders
  //    immediately and grows as the doc is patched.
  if (message.text && message.text.length > 0) {
    content.push({ type: "text", text: message.text });
  }

  // 2) Ordered parts (listByChat already returns them flat + sorted by order):
  //    reasoning, tool calls, media/file attachments.
  message.parts.forEach((p, index) => {
    if (isReasoningPart(p)) {
      content.push({ type: "reasoning", text: p.text } as ContentPart);
    } else if (isToolPart(p)) {
      content.push(toolPartToContent(message, index, p));
    } else if (isMediaPart(p) || isFilePart(p)) {
      const fileContent = filePartToContent(p);
      if (fileContent) content.push(fileContent);
    }
  });

  // assistant-ui requires at least one content part to render a bubble; if a
  // message somehow has neither text nor parts yet, emit an empty text part so
  // the streaming placeholder still appears.
  if (content.length === 0) {
    content.push({ type: "text", text: "" });
  }

  return {
    id: message._id,
    role: message.role,
    createdAt: new Date(message.updatedAt ?? message._creationTime),
    content,
    // Surface error text on the message so the Thread can style failed turns;
    // assistant-ui reads custom `metadata` for renderers that opt in.
    metadata: {
      custom: {
        // The Convex message _id — surfaced so per-message actions (delete) call
        // the mutation with the authoritative id, not assistant-ui's internal one.
        messageId: message._id,
        status: message.status,
        runId: message.runId ?? null,
        error: message.error ?? null,
      },
    },
  } satisfies ThreadMessageLike;
}
