import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
} from "@assistant-ui/react";
import { useAuthActions } from "@convex-dev/auth/react";
import type { ConvexId } from "./convexTypes";
import { useConvexChatRuntime } from "./useConvexChatRuntime";
import { RunStatus } from "./RunStatus";
import { ToolCard } from "./ToolCard";
import { MediaPart } from "./MediaPart";

// Top-level chat surface. Wires the reactive Convex-backed runtime into
// assistant-ui and renders the thread with custom renderers for run status,
// tool cards, and media (audio for TTS). No HTTP chat transport is used.

export interface ConvexChatProps {
  chatId: ConvexId<"chats"> | null;
}

export function ConvexChat({ chatId }: ConvexChatProps) {
  const runtime = useConvexChatRuntime({ chatId });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="oc-chat">
        <ChatHeader />
        {chatId ? (
          <ChatThread />
        ) : (
          <div className="oc-empty">Select or create a chat to begin.</div>
        )}
      </div>
    </AssistantRuntimeProvider>
  );
}

function ChatHeader() {
  const { signOut } = useAuthActions();
  return (
    <header className="oc-chat__header">
      <span className="oc-chat__title">OpenClaw</span>
      <button
        type="button"
        className="oc-chat__signout"
        onClick={() => {
          // Sign-out closes the Convex Auth session; the AuthLoading/
          // Unauthenticated boundary in main.tsx then swaps back to the sign-in
          // view. The bridge's OpenClaw socket is per-deployment, not per tab,
          // so nothing to tear down client-side here.
          void signOut();
        }}
      >
        Sign out
      </button>
    </header>
  );
}

function ChatThread() {
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
      <Composer />
    </ThreadPrimitive.Root>
  );
}

const contentComponents = {
  // Tool calls -> ToolCard; file parts (media + attachments) -> MediaPart.
  // reasoning + text use assistant-ui defaults.
  tools: { Fallback: ToolCard },
  File: MediaPart,
} as const;

function UserMessage() {
  return (
    <MessagePrimitive.Root className="oc-msg oc-msg--user">
      <div className="oc-msg__body">
        <MessagePrimitive.Content components={contentComponents} />
      </div>
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="oc-msg oc-msg--assistant">
      <div className="oc-msg__body">
        <MessagePrimitive.Content components={contentComponents} />
        <RunStatus />
      </div>
    </MessagePrimitive.Root>
  );
}

function SystemMessage() {
  return (
    <MessagePrimitive.Root className="oc-msg oc-msg--system">
      <div className="oc-msg__body">
        <MessagePrimitive.Content components={contentComponents} />
      </div>
    </MessagePrimitive.Root>
  );
}

function Composer() {
  return (
    <ComposerPrimitive.Root className="oc-composer">
      <ComposerPrimitive.Attachments />
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
