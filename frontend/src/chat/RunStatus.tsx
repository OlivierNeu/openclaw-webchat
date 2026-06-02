import { useMessage } from "@assistant-ui/react";
import type { MessageStatus } from "./convexTypes";

// Renders the run lifecycle for an assistant message, driven by the normalizer's
// `run.status {status, runId}` events which the bridge materialises into the
// Convex message's `status` / `runId` fields. Reactive: when the bridge patches
// status from "streaming" -> "complete" | "error" | "aborted", useQuery re-runs
// and this re-renders without any HTTP turn.

interface RunMeta {
  status?: MessageStatus;
  runId?: string | null;
  error?: string | null;
}

const LABEL: Record<MessageStatus, string> = {
  streaming: "Running",
  complete: "Done",
  error: "Error",
  aborted: "Stopped",
};

export function RunStatus() {
  const meta = useMessage(
    (m) => (m.metadata?.custom ?? {}) as RunMeta,
  );
  const status = meta.status;
  if (!status || status === "complete") return null;

  return (
    <div className={`oc-run-status oc-run-status--${status}`} role="status">
      <span className="oc-run-status__dot" aria-hidden />
      <span className="oc-run-status__label">{LABEL[status]}</span>
      {meta.runId ? (
        <span className="oc-run-status__run" title={`run ${meta.runId}`}>
          {meta.runId.slice(0, 8)}
        </span>
      ) : null}
      {status === "error" && meta.error ? (
        <span className="oc-run-status__error">{meta.error}</span>
      ) : null}
    </div>
  );
}
