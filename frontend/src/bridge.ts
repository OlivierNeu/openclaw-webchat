// Framework-free helpers for the stable bridge contract. Kept out of the React
// component so the streaming reducer (the mirror of the backend normalizer) and
// the link/safety helpers can be unit-tested directly.

export type MediaItem = { filename: string; url?: string };
export type Streaming = { text: string; media: MediaItem[] };

export type StreamUpdate = {
  streaming: Streaming | null;
  final?: { text: string; error: boolean; media: MediaItem[] };
};

const EMPTY: Streaming = { text: "", media: [] };

/**
 * Pure reducer for the stable bridge events that affect the in-progress reply.
 *
 *   message.delta    -> append text
 *   message.snapshot -> replace text
 *   media            -> append media items
 *   run.status=compacting -> reset the partial (the abandoned run is invalid)
 *   message.final    -> finalize and clear streaming
 *
 * Any other event leaves the streaming state untouched.
 */
export function applyStreamEvent(
  streaming: Streaming | null,
  event: Record<string, unknown>
): StreamUpdate {
  const current = streaming ?? EMPTY;
  switch (event.type) {
    case "message.delta":
      return {
        streaming: { text: current.text + String(event.text ?? ""), media: current.media }
      };
    case "message.snapshot":
      return { streaming: { text: String(event.text ?? ""), media: current.media } };
    case "media": {
      const items = Array.isArray(event.items) ? (event.items as MediaItem[]) : [];
      if (items.length === 0) {
        return { streaming };
      }
      return { streaming: { text: current.text, media: [...current.media, ...items] } };
    }
    case "run.status":
      if (event.status === "compacting") {
        // Auto-compaction invalidates everything the abandoned run produced.
        return { streaming: EMPTY };
      }
      return { streaming };
    case "message.final":
      return {
        streaming: null,
        final: {
          text: String(event.text ?? ""),
          error: Boolean(event.error),
          media: current.media
        }
      };
    default:
      return { streaming };
  }
}

/** Only http(s) links are allowed; refuses javascript:/data:/relative-scheme. */
export function safeHref(href: string, origin: string): string | null {
  try {
    const url = new URL(href, origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    return href;
  } catch {
    return null;
  }
}

/** Flatten a chat.history message content (string or list of {text} parts). */
export function textFromContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }
      if (part && typeof part === "object" && "text" in part) {
        return String((part as { text?: unknown }).text ?? "");
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/** Human-readable label for a run.status value. */
export function statusLabel(status: unknown): string {
  switch (status) {
    case "started":
    case "running":
      return "Réponse en cours…";
    case "working":
      return "OpenClaw finalise la réponse…";
    case "compacting":
      return "Compaction en cours…";
    case "final":
      return "OpenClaw a terminé.";
    case "error":
      return "OpenClaw a signalé une erreur.";
    case "aborted":
      return "Tour interrompu.";
    default:
      return "";
  }
}
