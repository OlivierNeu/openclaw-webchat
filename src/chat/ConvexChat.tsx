import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
} from "@assistant-ui/react";
import { useQuery, useMutation } from "convex/react";
import { api } from "./convexApi";
import type { ConvexId } from "./convexTypes";
import { useConvexChatRuntime } from "./useConvexChatRuntime";
import { RunStatus } from "./RunStatus";
import { ToolCard } from "./ToolCard";
import { MediaPart } from "./MediaPart";
import { MarkdownText } from "./MarkdownText";

// Top-level chat surface. Wires the reactive Convex-backed runtime into
// assistant-ui and renders the thread with custom renderers for run status,
// tool cards, and media (audio for TTS). No HTTP chat transport is used.

export interface ConvexChatProps {
  chatId: ConvexId<"chats"> | null;
}

export function ConvexChat({ chatId }: ConvexChatProps) {
  const runtime = useConvexChatRuntime({ chatId });
  // Per-user "show tool cards" preference (reactive). Absent => shown.
  const me = useQuery(api.me.getMe);
  const showTools = me?.showTools ?? true;
  const setShowTools = useMutation(api.me.setShowTools);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className={`oc-chat${showTools ? "" : " oc-hide-tools"}`}>
        {chatId ? (
          <ChatThread
            showTools={showTools}
            onToggleTools={() => void setShowTools({ show: !showTools })}
          />
        ) : (
          <div className="oc-empty">Select or create a chat to begin.</div>
        )}
      </div>
    </AssistantRuntimeProvider>
  );
}

function ChatThread({
  showTools,
  onToggleTools,
}: {
  showTools: boolean;
  onToggleTools: () => void;
}) {
  return (
    <ThreadPrimitive.Root className="oc-thread">
      <ThreadPrimitive.Viewport className="oc-thread__viewport">
        <ThreadPrimitive.Messages
          components={{
            UserMessage,
            AssistantMessage,
            SystemMessage,
          }}
        />
      </ThreadPrimitive.Viewport>
      <Composer showTools={showTools} onToggleTools={onToggleTools} />
    </ThreadPrimitive.Root>
  );
}

// Component overrides for MessagePrimitive.Parts (assistant-ui 0.14):
//   - tool calls -> ToolCard (via tools.Fallback)
//   - file parts (media + attachments) -> MediaPart
// Typed loosely at this seam: our ToolCard/MediaPart accept the structural
// props assistant-ui passes; the exact exported component types shifted in 0.14.
//
// Assistant turns ALSO override Text -> MarkdownText (GFM rendering). User and
// system turns intentionally do NOT: a user's literal input must not be
// reinterpreted as markdown (typing `*foo*` must stay `*foo*`), so they keep the
// default plain-text renderer.
const plainComponents = {
  tools: { Fallback: ToolCard as never },
  File: MediaPart as never,
};
const assistantComponents = {
  ...plainComponents,
  Text: MarkdownText,
};

// User turn: a subtle, low-contrast bubble aligned right (Open WebUI style).
// Uses --muted (light grey in light, elevated grey in dark) instead of the
// high-contrast --primary, so it never flips to a tiring solid white/black.
function UserMessage() {
  return (
    <MessagePrimitive.Root className="oc-msg oc-msg--user">
      <div className="oc-msg__bubble">
        <MessagePrimitive.Parts components={plainComponents} />
      </div>
    </MessagePrimitive.Root>
  );
}

// Assistant turn: NO background bubble — content sits on the page background and
// fills the readable column (Open WebUI style). An avatar + name header carries
// the identity; RunStatus shows the live status (and hides itself when done).
function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="oc-msg oc-msg--assistant">
      <div className="oc-msg__avatar" aria-hidden>
        OC
      </div>
      <div className="oc-msg__col">
        <div className="oc-msg__name">OpenClaw</div>
        <div className="oc-msg__body">
          <MessagePrimitive.Parts components={assistantComponents} />
          <RunStatus />
        </div>
      </div>
    </MessagePrimitive.Root>
  );
}

function SystemMessage() {
  return (
    <MessagePrimitive.Root className="oc-msg oc-msg--system">
      <div className="oc-msg__body">
        <MessagePrimitive.Parts components={plainComponents} />
      </div>
    </MessagePrimitive.Root>
  );
}

function Composer({
  showTools,
  onToggleTools,
}: {
  showTools: boolean;
  onToggleTools: () => void;
}) {
  return (
    <ComposerPrimitive.Root className="oc-composer">
      <button
        type="button"
        className={`oc-composer__toolstoggle${showTools ? " is-on" : ""}`}
        onClick={onToggleTools}
        aria-pressed={showTools}
        title={
          showTools
            ? "Masquer les outils exécutés par OpenClaw"
            : "Afficher les outils exécutés par OpenClaw"
        }
      >
        🔧 {showTools ? "Outils" : "Outils masqués"}
      </button>
      <ComposerPrimitive.Attachments components={{}} />
      <ComposerPrimitive.AddAttachment className="oc-composer__attach">
        Attach
      </ComposerPrimitive.AddAttachment>
      <ComposerPrimitive.Input
        className="oc-composer__input"
        placeholder="Message OpenClaw..."
        autoFocus
      />
      <ThreadPrimitive.If running={false}>
        <ComposerPrimitive.Send className="oc-composer__send">
          Send
        </ComposerPrimitive.Send>
      </ThreadPrimitive.If>
      <ThreadPrimitive.If running>
        <ComposerPrimitive.Cancel className="oc-composer__cancel">
          Stop
        </ComposerPrimitive.Cancel>
      </ThreadPrimitive.If>
    </ComposerPrimitive.Root>
  );
}
