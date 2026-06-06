import {
  ActionBarPrimitive,
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
} from "@assistant-ui/react";
import type { ReactNode } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "./convexApi";
import type { Id } from "./convexApi";
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
            chatId={chatId}
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
  chatId,
  showTools,
  onToggleTools,
}: {
  chatId: ConvexId<"chats">;
  showTools: boolean;
  onToggleTools: () => void;
}) {
  return (
    <ThreadPrimitive.Root className="oc-thread">
      <ChatHeader chatId={chatId} />
      <ThreadPrimitive.Viewport className="oc-thread__viewport">
        <ThreadPrimitive.Empty>
          <ThreadEmptyState />
        </ThreadPrimitive.Empty>
        <ThreadPrimitive.Messages
          components={{
            UserMessage,
            AssistantMessage,
            SystemMessage,
          }}
        />
      </ThreadPrimitive.Viewport>
      {/* Auto-hides (returns null) when the viewport is at the bottom; also
          suppressed on an empty thread (nothing to scroll to). */}
      <ThreadPrimitive.If empty={false}>
        <ThreadPrimitive.ScrollToBottom className="oc-scrolldown">
          <IconArrowDown />
          <span>Derniers messages</span>
        </ThreadPrimitive.ScrollToBottom>
      </ThreadPrimitive.If>
      <Composer showTools={showTools} onToggleTools={onToggleTools} />
    </ThreadPrimitive.Root>
  );
}

// Empty-state (CHAT_UX_DESIGN Part 3): capability transparency + a few
// suggested prompts for the "vague prompt" conversation type. Each suggestion
// FILLS the composer (send={false}) so the user reviews/edits before sending,
// rather than firing immediately. The prompts showcase proven agent
// capabilities (web search, mail, downloadable file exchange).
const SUGGESTED_PROMPTS: string[] = [
  "Fais une recherche web et résume l’actualité IA de cette semaine, avec sources.",
  "Crée un fichier markdown récapitulatif et joins-le moi en pièce jointe téléchargeable.",
  "Résume mes derniers e-mails importants et propose des réponses.",
  "Quelles sont tes capacités ? Donne 5 exemples concrets de ce que tu peux faire.",
];

function ThreadEmptyState() {
  return (
    <div className="oc-emptystate">
      <div className="oc-emptystate__avatar" aria-hidden>
        OC
      </div>
      <h2 className="oc-emptystate__title">Comment puis-je aider ?</h2>
      <p className="oc-emptystate__subtitle">
        Posez une question, ou partez d’une suggestion ci-dessous.
      </p>
      <div className="oc-emptystate__suggestions">
        {SUGGESTED_PROMPTS.map((prompt) => (
          <ThreadPrimitive.Suggestion
            key={prompt}
            prompt={prompt}
            send={false}
            className="oc-suggestion"
          >
            {prompt}
          </ThreadPrimitive.Suggestion>
        ))}
      </div>
    </div>
  );
}

// Chat-header "spotted strip" (CHAT_UX_DESIGN.md Part 3): surfaces the OpenClaw
// session knobs as FEATURES — current model, reasoning (thinking) level with its
// inheritance hint, and the always-visible context-usage meter. Data comes from
// the gateway's self-describing `sessions.describe` (mirrored to Convex by the
// bridge), so a new model / thinking level surfaces with no frontend change.
// Read-only here; the write-back ("Advanced ▾") is a later increment. Renders
// nothing until session meta exists, so it never flashes an empty bar.
function ChatHeader({ chatId }: { chatId: ConvexId<"chats"> }) {
  // ConvexId<"chats"> is our structural string-id type; the generated arg
  // validator wants the branded Id (same cast the runtime uses for listByChat).
  const meta = useQuery(api.messages.getSessionMeta, {
    chatId: chatId as Id<"chats">,
  });
  const sm = meta?.sessionMeta ?? null;
  if (!sm) return null;

  const pct =
    sm.totalTokens != null && sm.contextTokens && sm.contextTokens > 0
      ? Math.round((sm.totalTokens / sm.contextTokens) * 100)
      : null;
  // "Spotted" meter color: calm until the context window fills, then escalates.
  const meterLevel =
    pct == null ? "" : pct >= 90 ? "is-critical" : pct >= 75 ? "is-warn" : "is-ok";
  const inherited =
    !!sm.thinkingLevel &&
    !!sm.thinkingDefault &&
    sm.thinkingLevel === sm.thinkingDefault;

  return (
    <header className="oc-chathead">
      <div className="oc-chathead__title" title={meta?.title ?? undefined}>
        {meta?.title || "Conversation"}
      </div>
      <div className="oc-chathead__meta">
        {sm.model ? (
          <span
            className="oc-chip"
            title={`Modèle${sm.modelProvider ? ` · ${sm.modelProvider}` : ""}`}
          >
            <IconCpu />
            {sm.model}
          </span>
        ) : null}
        {sm.thinkingLevel ? (
          <span
            className="oc-chip"
            title={
              inherited
                ? "Niveau de réflexion hérité de l’agent"
                : "Niveau de réflexion (spécifique à ce chat)"
            }
          >
            <IconBrain />
            Réflexion&nbsp;: {capitalize(sm.thinkingLevel)}
            {inherited ? <span className="oc-chip__hint">héritée</span> : null}
          </span>
        ) : null}
        {pct != null ? (
          <span
            className={`oc-meter ${meterLevel}`}
            title={`Contexte utilisé : ${pct}% (${formatTokens(
              sm.totalTokens as number,
            )} / ${formatTokens(sm.contextTokens as number)} tokens)`}
          >
            <span className="oc-meter__track">
              <span
                className="oc-meter__fill"
                style={{ width: `${Math.min(pct, 100)}%` }}
              />
            </span>
            <span className="oc-meter__label">
              {pct}% · {formatTokens(sm.totalTokens as number)}/
              {formatTokens(sm.contextTokens as number)}
            </span>
          </span>
        ) : null}
      </div>
    </header>
  );
}

/** Compact token count: 62226 -> "62.2k", 980 -> "980". */
function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function capitalize(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

// Inline Lucide-style icons (no emoji, no extra dep). 16px, currentColor.
function IconCpu() {
  return (
    <svg
      className="oc-chip__icon"
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <rect x="9" y="9" width="6" height="6" />
      <path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3" />
    </svg>
  );
}

function IconBrain() {
  return (
    <svg
      className="oc-chip__icon"
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 5a3 3 0 1 0-5.997.142 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" />
      <path d="M12 5a3 3 0 1 1 5.997.142 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" />
    </svg>
  );
}

// Shared 16px inline-SVG icon (Lucide geometry, currentColor) for the buttons.
function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  );
}

function IconArrowDown() {
  return (
    <Icon>
      <path d="M12 5v14M19 12l-7 7-7-7" />
    </Icon>
  );
}

function IconCopy() {
  return (
    <Icon>
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </Icon>
  );
}

function IconCheck() {
  return (
    <Icon>
      <path d="M20 6 9 17l-5-5" />
    </Icon>
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
        {/* Per-message Copy. Hidden while a turn runs, revealed on hover for
            non-last turns (autohide). NOTE: a "Régénérer" (Reload) action is
            intentionally NOT rendered yet — the external-store runtime
            (useConvexChatRuntime) only implements `onNew`, so `ActionBar.Reload`
            would be a dead/no-op button. Add it together with an `onReload`
            re-dispatch of the last user turn (a future increment, also needs a
            working gateway to verify). */}
        <ActionBarPrimitive.Root
          className="oc-msg__actions"
          hideWhenRunning
          autohide="not-last"
        >
          <ActionBarPrimitive.Copy className="oc-iconbtn" title="Copier la réponse">
            <MessagePrimitive.If copied>
              <IconCheck />
            </MessagePrimitive.If>
            <MessagePrimitive.If copied={false}>
              <IconCopy />
            </MessagePrimitive.If>
          </ActionBarPrimitive.Copy>
        </ActionBarPrimitive.Root>
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
