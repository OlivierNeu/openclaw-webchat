// Pure mapping from a turn's (status, hasText) to the run-status chip view.
//
// Extracted as a pure function on purpose: the streaming states it drives
// ("Réflexion…", "Génération…") are TRANSIENT and hard to screenshot reliably
// (a fast turn's no-text window can be <200ms), so correctness is pinned by a
// unit test here rather than only by a live capture (see runStatusView.test.ts).
//
//   thinking   = streaming with NO visible text yet  -> the typing indicator
//   generating = streaming WITH text                 -> "still writing" footer
//   error      = the run failed                       -> legible error + message
//   aborted    = the user stopped it                  -> "Interrompu"
//   (complete or unknown)                             -> null (no chip)

export type RunStatusKind = "thinking" | "generating" | "error" | "aborted";

export interface RunStatusView {
  kind: RunStatusKind;
  /** French, user-facing. */
  label: string;
}

export function runStatusView(
  status: string | undefined,
  hasText: boolean,
): RunStatusView | null {
  // `undefined` status is the assistant-ui core's OPTIMISTIC placeholder (the
  // upcoming-message it injects while `isRunning` before any real assistant doc
  // exists) — it carries no `metadata.custom.status`. Render the SAME "thinking"
  // indicator so this placeholder fills the send->first-token gap, then hands off
  // seamlessly to the real streaming doc (identical label). Handled BEFORE the
  // switch so a real "complete" message still maps to null (no chip). Real
  // messages always carry a schema-required status, so this only ever matches
  // the placeholder.
  if (status === undefined) return { kind: "thinking", label: "Réflexion…" };
  switch (status) {
    case "streaming":
      return hasText
        ? { kind: "generating", label: "Génération…" }
        : { kind: "thinking", label: "Réflexion…" };
    case "error":
      return { kind: "error", label: "Erreur" };
    case "aborted":
      return { kind: "aborted", label: "Interrompu" };
    default:
      // "complete" (and any unknown/absent status) shows no chip.
      return null;
  }
}

/** True if the assistant message has at least one non-empty text part. */
export function messageHasText(
  content: ReadonlyArray<{ type?: string; text?: unknown }> | undefined,
): boolean {
  if (!content) return false;
  return content.some(
    (p) =>
      p?.type === "text" &&
      typeof p.text === "string" &&
      p.text.trim().length > 0,
  );
}
