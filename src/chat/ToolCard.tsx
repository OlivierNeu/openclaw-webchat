// Props mirror assistant-ui's tool-call content-part component shape. We type
// them locally because the exported `ToolCallContentPartComponent` type was
// removed/renamed in @assistant-ui/react 0.14; the runtime contract (the fields
// passed to a tool component) is unchanged.
type ToolCardProps = {
  toolName: string;
  args?: unknown;
  argsText?: string;
  result?: unknown;
  status?: { type?: string } | undefined;
};

// Renders a single tool invocation. The bridge normalizer emits
// `tool.status {name, phase, runId}` events; the bridge stores them as
// messageParts of kind:"tool" (name, phase, input?, output?). convertMessage
// turns each into an assistant-ui `tool-call` content part, and assistant-ui
// routes it here. Phase/output stream in reactively as the bridge patches the
// part, so the card fills in (input first, output when the tool completes)
// without any per-turn HTTP request.

function phaseClass(phaseRaw: unknown, hasResult: boolean): string {
  const phase = typeof phaseRaw === "string" ? phaseRaw : undefined;
  if (phase === "error") return "error";
  if (hasResult || phase === "completed") return "completed";
  if (phase === "running" || phase === "started") return "running";
  return "running";
}

function pretty(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function ToolCard({
  toolName,
  args,
  argsText,
  result,
  status,
}: ToolCardProps) {
  const hasResult = result !== undefined && result !== null;
  // assistant-ui status.type is "running" | "complete" | "incomplete" | ...
  const phase = phaseClass(status?.type, hasResult);
  const inputText = argsText ?? pretty(args);

  return (
    <div className={`oc-tool oc-tool--${phase}`}>
      <div className="oc-tool__header">
        <span className="oc-tool__icon" aria-hidden>
          {phase === "completed" ? "✓" : phase === "error" ? "✕" : "⋯"}
        </span>
        <span className="oc-tool__name">{toolName}</span>
        <span className="oc-tool__phase">{phase}</span>
      </div>
      {inputText ? (
        <details className="oc-tool__io" open={!hasResult}>
          <summary>input</summary>
          <pre className="oc-tool__pre">{inputText}</pre>
        </details>
      ) : null}
      {hasResult ? (
        <details className="oc-tool__io" open>
          <summary>output</summary>
          <pre className="oc-tool__pre">{pretty(result)}</pre>
        </details>
      ) : null}
    </div>
  );
}
