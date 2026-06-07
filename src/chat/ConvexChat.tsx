import {
  ActionBarPrimitive,
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useMessage,
} from "@assistant-ui/react";
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQuery, useMutation, useConvex } from "convex/react";
import { useNavigate } from "@tanstack/react-router";
import { api } from "./convexApi";
import type { Id } from "./convexApi";
import type { ConvexId, ConvexMessageView } from "./convexTypes";
import {
  transcriptToMarkdown,
  transcriptToJson,
  exportFilename,
  type ExportMessage,
} from "./transcriptExport";
import {
  SlidersHorizontal,
  ChevronDown,
  Download,
  Plus,
  ArrowUp,
  Square,
  Mic,
  Trash2,
  Code,
  Search,
  CircleAlert,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useConfirm } from "@/components/ConfirmDialog";
import { useConvexChatRuntime } from "./useConvexChatRuntime";
import { RunStatus } from "./RunStatus";
import { ToolCard } from "./ToolCard";
import { MediaPart } from "./MediaPart";
import { MarkdownText } from "./MarkdownText";
import { FeedbackButton } from "./FeedbackDialog";

// Top-level chat surface. Wires the reactive Convex-backed runtime into
// assistant-ui and renders the thread with custom renderers for run status,
// tool cards, and media (audio for TTS). No HTTP chat transport is used.

export interface ConvexChatProps {
  chatId: ConvexId<"chats"> | null;
}

// Effective per-user UI toggles, resolved by getMe.ui (see convex/lib/uiPrefs).
// Provided via context so the deep action-bar buttons render conditionally
// without prop-drilling through assistant-ui's message primitives.
export type UiEffective = {
  showSource: boolean;
  showReport: boolean;
  copyAssistant: boolean;
  copyUser: boolean;
  showDelete: boolean;
  showTools: boolean;
  voiceInput: boolean;
};
const DEFAULT_UI: UiEffective = {
  showSource: true,
  showReport: true,
  copyAssistant: true,
  copyUser: true,
  showDelete: true,
  showTools: true,
  voiceInput: false,
};
const UiPrefsContext = createContext<UiEffective>(DEFAULT_UI);
function useUiPrefs(): UiEffective {
  return useContext(UiPrefsContext);
}

export function ConvexChat({ chatId }: ConvexChatProps) {
  const runtime = useConvexChatRuntime({ chatId });
  // Resolved UI preferences (reactive): the single source for which interface
  // elements render. The composer "Outils" quick toggle writes through the same
  // single path (setUiPref), so it stays consistent with the Préférences panel.
  const me = useQuery(api.me.getMe);
  const ui = (me?.ui?.effective as UiEffective | undefined) ?? DEFAULT_UI;
  const showTools = ui.showTools;
  const setUiPref = useMutation(api.me.setUiPref);

  // Not-found detection for a deep-linked chat. getSessionMeta returns `null` once
  // LOADED for a malformed/deleted chat (and `undefined` while still loading), so
  // `meta === null` with a chatId present means "this conversation does not exist"
  // — we render a clean in-shell message instead of an empty thread. (The backend
  // queries tolerate a malformed id via normalizeId, so this never throws.)
  const meta = useQuery(
    api.messages.getSessionMeta,
    chatId ? { chatId: chatId as Id<"chats"> } : "skip",
  );
  const notFound = chatId !== null && meta === null;

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <UiPrefsContext.Provider value={ui}>
        <div className={`oc-chat${showTools ? "" : " oc-hide-tools"}`}>
          {chatId ? (
            notFound ? (
              <ChatNotFound />
            ) : (
              <ChatThread
                chatId={chatId}
                showTools={showTools}
                onToggleTools={() =>
                  void setUiPref({ key: "showTools", value: !showTools })
                }
              />
            )
          ) : (
            <div className="oc-empty">Select or create a chat to begin.</div>
          )}
        </div>
      </UiPrefsContext.Provider>
    </AssistantRuntimeProvider>
  );
}

// Clean, in-application "conversation not found" state for a stale/typo'd deep
// link (the backend returns not-found rather than throwing, so the user never
// sees the router's raw error screen). Stays inside the app shell (sidebar +
// top bar remain) and offers a way forward.
function ChatNotFound() {
  const navigate = useNavigate();
  return (
    <div className="oc-notfound" role="status">
      <div className="oc-notfound__icon" aria-hidden>
        <Search size={28} />
      </div>
      <h2 className="oc-notfound__title">Conversation introuvable</h2>
      <p className="oc-notfound__body">
        Ce lien ne correspond à aucune conversation. Elle a peut-être été
        supprimée, ou l’adresse est incomplète.
      </p>
      <button
        type="button"
        className="oc-notfound__cta"
        onClick={() => void navigate({ to: "/" })}
      >
        <Plus size={16} aria-hidden />
        Nouvelle conversation
      </button>
    </div>
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
  // Chat availability gate: if the bridge is down/erroring (active health poll),
  // grey out the composer and show a banner BEFORE a turn is persisted — the
  // user never sends a message that cannot reach the agent. Fail-open: while
  // health is unknown (undefined / known:false) we do NOT block. The
  // failDispatch error bubble remains the backstop for a send that slips through.
  const avail = useQuery(api.bridgeHealth.getBridgeAvailability, {});
  const unavailable = avail && !avail.available ? avail : null;
  return (
    <ThreadPrimitive.Root className="oc-thread">
      <ChatHeader chatId={chatId} />
      <ThreadAnnouncer chatId={chatId} />
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
      {unavailable ? <BridgeUnavailableBanner /> : null}
      <Composer
        showTools={showTools}
        onToggleTools={onToggleTools}
        unavailable={unavailable !== null}
      />
    </ThreadPrimitive.Root>
  );
}

// Standardized, user-facing "chat unavailable" notice shown above a greyed-out
// composer. Generic on purpose (the technical reason is admin-only, in Settings →
// Santé / Traces); the user just needs to know not to type and to retry.
function BridgeUnavailableBanner() {
  return (
    <div className="oc-chat-banner oc-chat-banner--error" role="status">
      <CircleAlert size={16} aria-hidden />
      <span>
        Le service de chat est momentanément indisponible. L’envoi de message est
        suspendu — réessayez dans un instant. Si cela persiste, contactez votre
        administrateur.
      </span>
    </div>
  );
}

// Screen-reader announcement of turn COMPLETION (CHAT_UX_DESIGN a11y). The
// RunStatus chip (role="status") announces "Réflexion…"/"Erreur" but goes to null
// on complete — so without this a SR user hears the start then SILENCE. This is a
// PERSISTENT, initially-EMPTY aria-live region (mounting it WITH text suppresses
// the announcement on many SRs); it is populated with a SHORT CUE once per
// completed assistant turn (NOT the full answer — a polite region would read it
// all; the answer stays in the transcript for normal navigation).
function ThreadAnnouncer({ chatId }: { chatId: ConvexId<"chats"> }) {
  // Reuses the runtime's owner-scoped query (Convex dedupes identical args).
  const messages = useQuery(api.messages.listByChat, {
    chatId: chatId as Id<"chats">,
  }) as ConvexMessageView[] | undefined;
  const [announcement, setAnnouncement] = useState("");
  const lastAnnouncedId = useRef<string | null>(null);

  // Reset the baseline when switching chats (the component is reused, not
  // remounted), so a prior chat's last turn never re-announces in the new one.
  useEffect(() => {
    lastAnnouncedId.current = null;
    setAnnouncement("");
  }, [chatId]);

  useEffect(() => {
    if (!messages) return;
    let latest: ConvexMessageView | undefined;
    for (const m of messages) if (m.role === "assistant") latest = m;
    if (!latest || latest.status !== "complete") return;
    if (lastAnnouncedId.current === null) {
      // First settled assistant turn after load/switch: adopt as baseline
      // WITHOUT announcing (it is history, not a just-arrived reply).
      lastAnnouncedId.current = latest._id;
      return;
    }
    if (lastAnnouncedId.current !== latest._id) {
      lastAnnouncedId.current = latest._id;
      // Toggle a trailing space so the textContent actually CHANGES even for a
      // second identical cue (a polite region only announces on content change).
      setAnnouncement((prev) =>
        prev === "Réponse reçue." ? "Réponse reçue. " : "Réponse reçue.",
      );
    }
  }, [messages]);

  return (
    <div aria-live="polite" aria-atomic="true" className="oc-sr-only">
      {announcement}
    </div>
  );
}

// Empty-state (CHAT_UX_DESIGN Part 3): capability transparency + a few
// suggested prompts for the "vague prompt" conversation type. Each suggestion
// Minimal welcome — a calm avatar + prompt, NO suggestion cards (per Olivier's
// feedback: a new chat should not push canned suggestions).
function ThreadEmptyState() {
  return (
    <div className="oc-emptystate">
      <div className="oc-emptystate__avatar" aria-hidden>
        OC
      </div>
      <h2 className="oc-emptystate__title">Comment puis-je aider ?</h2>
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
        <ExportMenu chatId={chatId} title={meta?.title ?? null} />
        <SessionKnobsMenu chatId={chatId} sm={sm} />
      </div>
    </header>
  );
}

// Trigger a client-side file download from in-memory text (no server round-trip
// beyond the owner-scoped query that produced it).
function downloadText(content: string, filename: string, mime: string): void {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Export the current transcript as Markdown or JSON. Reads the owner-scoped
// `listByChat` query imperatively on click (bounded to the 200-message window);
// when that cap is hit the serialized file carries an EXPLICIT truncation marker
// (a silent drop of older turns would betray "the transcript"). Serialization is
// the pure, unit-tested `transcriptTo*`. PHI: never logged — this is a
// user-initiated download of the user's OWN data.
function ExportMenu({
  chatId,
  title,
}: {
  chatId: ConvexId<"chats">;
  title: string | null;
}) {
  const convex = useConvex();

  async function run(format: "md" | "json"): Promise<void> {
    const rows = (await convex.query(api.messages.listByChat, {
      chatId: chatId as Id<"chats">,
    })) as ConvexMessageView[];
    const messages: ExportMessage[] = rows.map((m) => ({
      role: m.role,
      text: m.text,
      createdAt: m.updatedAt ?? m._creationTime,
      parts: m.parts.map((p) => ({
        kind: p.kind,
        filename: "filename" in p ? p.filename : undefined,
        name: "name" in p ? p.name : undefined,
      })),
    }));
    // 200 = MESSAGE_WINDOW; a full window means older messages may be omitted.
    const truncated = rows.length >= 200;
    const opts = { title: title ?? undefined, truncated, exportedAt: Date.now() };
    const stem = exportFilename(title);
    if (format === "md") {
      downloadText(transcriptToMarkdown(messages, opts), `${stem}.md`, "text/markdown");
    } else {
      downloadText(transcriptToJson(messages, opts), `${stem}.json`, "application/json");
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="oc-chip oc-chip--btn" title="Exporter la conversation">
          <Download size={13} aria-hidden />
          Exporter
          <ChevronDown size={13} className="oc-chip__chev" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuLabel>Exporter</DropdownMenuLabel>
        <DropdownMenuItem onClick={() => void run("md")}>Markdown (.md)</DropdownMenuItem>
        <DropdownMenuItem onClick={() => void run("json")}>JSON (.json)</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// "Advanced" write-back panel: change the OpenClaw reasoning level / model for
// THIS chat. The selected value is applied IMMEDIATELY by the bridge
// (sessions.patch) and the live `sessionMeta` (this menu's source of truth)
// refreshes — so the radio always reflects the gateway's real state, never an
// optimistic guess. `verboseLevel` is intentionally NOT exposed (the bridge pins
// it to "full" for complete streaming frames; see chats.setSessionKnob).
function SessionKnobsMenu({
  chatId,
  sm,
}: {
  chatId: ConvexId<"chats">;
  sm: {
    model?: string;
    thinkingLevel?: string;
    thinkingDefault?: string;
    thinkingLevels?: { id: string; label: string }[];
    availableModels?: { id: string; label: string }[];
  };
}) {
  const setKnob = useMutation(api.chats.setSessionKnob);
  const levels = sm.thinkingLevels ?? [];
  const models = sm.availableModels ?? [];
  // Nothing the gateway lets us change -> no menu (keeps the strip clean).
  if (levels.length === 0 && models.length === 0) return null;

  const def = sm.thinkingDefault;
  const defLabel = def
    ? (levels.find((l) => l.id === def)?.label ?? def)
    : null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="oc-chip oc-chip--btn" title="Réglages avancés (réflexion, modèle)">
          <SlidersHorizontal size={13} aria-hidden />
          Avancé
          <ChevronDown size={13} className="oc-chip__chev" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        {levels.length > 0 ? (
          <>
            <DropdownMenuLabel>Niveau de réflexion</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={sm.thinkingLevel ?? ""}
              onValueChange={(v) => void setKnob({ chatId: chatId as Id<"chats">, thinkingLevel: v })}
            >
              {levels.map((l) => (
                <DropdownMenuRadioItem key={l.id} value={l.id}>
                  {capitalize(l.label)}
                  {def && l.id === def ? (
                    <span className="oc-menu__hint">défaut</span>
                  ) : null}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            {def && sm.thinkingLevel !== def ? (
              <DropdownMenuItem
                onClick={() =>
                  void setKnob({ chatId: chatId as Id<"chats">, thinkingLevel: def })
                }
              >
                Hériter de l’agent{defLabel ? ` (${capitalize(defLabel)})` : ""}
              </DropdownMenuItem>
            ) : null}
          </>
        ) : null}
        {models.length > 0 ? (
          <>
            {levels.length > 0 ? <DropdownMenuSeparator /> : null}
            <DropdownMenuLabel>Modèle</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={sm.model ?? ""}
              onValueChange={(v) => void setKnob({ chatId: chatId as Id<"chats">, model: v })}
            >
              {models.map((m) => (
                <DropdownMenuRadioItem key={m.id} value={m.id}>
                  {m.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </>
        ) : null}
        <DropdownMenuSeparator />
        {/* Surface the deliberate exclusion: verbosity is pinned by the bridge for
            complete streaming, so it is shown (not silently dropped) but not editable. */}
        <div className="oc-menu__note">Verbosité : fixée à « full » pour le streaming</div>
      </DropdownMenuContent>
    </DropdownMenu>
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
// Per-message delete. Reads the Convex message id from metadata (authoritative,
// set in convertMessage) and calls deleteMessage. Truncate-forward semantics live
// in the mutation: deleting an assistant turn regenerates the last user turn;
// deleting a user turn removes it + all following. The cascade is destructive +
// has no undo, so the user-message variant confirms first.
function DeleteMessageButton({ kind }: { kind: "user" | "assistant" }) {
  const messageId = useMessage(
    (m) => (m.metadata?.custom as { messageId?: string } | undefined)?.messageId,
  );
  const del = useMutation(api.messages.deleteMessage);
  // Styled, promise-based confirm (radix AlertDialog) — replaces window.confirm.
  // BOTH roles confirm (the action is destructive either way), with copy that
  // matches the actual behavior: user = cascade, assistant = delete + regenerate.
  const confirm = useConfirm();
  if (!messageId) return null;

  async function onDelete(): Promise<void> {
    const ok = await confirm(
      kind === "assistant"
        ? {
            title: "Supprimer et régénérer cette réponse ?",
            description:
              "Cette réponse sera supprimée, puis régénérée à partir de votre dernier message.",
            confirmLabel: "Régénérer",
            cancelLabel: "Annuler",
            destructive: true,
          }
        : {
            title: "Supprimer ce message et les suivants ?",
            description:
              "Ce message et tous les messages qui le suivent seront supprimés de la conversation. Cette action est irréversible.",
            confirmLabel: "Supprimer",
            cancelLabel: "Annuler",
            destructive: true,
          },
    );
    if (!ok) return;
    await del({ messageId: messageId as Id<"messages"> });
  }

  return (
    <button
      type="button"
      className="oc-iconbtn oc-iconbtn--danger"
      title={
        kind === "assistant"
          ? "Supprimer et régénérer la réponse"
          : "Supprimer ce message et les suivants"
      }
      aria-label="Supprimer le message"
      onClick={() => void onDelete()}
    >
      <Trash2 size={15} aria-hidden />
    </button>
  );
}

// "Source" view: the EXACT stored text, verbatim — no markdown, no autocorrect,
// no transformation of any kind. This is the convention-free trust guarantee:
// for a USER turn it's exactly what was typed/sent; for an ASSISTANT turn it's
// the gateway's final text (our pipeline leaves prose byte-identical — only
// server paths are stripped for security; see bridge/sanitize.ts). It lets a
// user verify a word was not silently changed by autocorrect or by rendering.
function MessageSource() {
  const raw = useMessage(
    (m) => (m.metadata?.custom as { rawText?: string } | undefined)?.rawText ?? "",
  );
  const [copied, setCopied] = useState(false);
  // Count CODE POINTS, not UTF-16 units (`.length`), so an emoji / non-BMP char
  // does not inflate the count — the number must be trustworthy.
  const codePoints = [...raw].length;
  return (
    <div className="oc-msg__source">
      <div className="oc-msg__source-head">
        <span className="oc-msg__source-label">
          Source · texte brut exact · {codePoints} caractère{codePoints > 1 ? "s" : ""}
        </span>
        <button
          type="button"
          className="oc-iconbtn"
          title="Copier la source exacte"
          aria-label="Copier la source exacte"
          onClick={() => {
            void navigator.clipboard?.writeText(raw).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1200);
            });
          }}
        >
          {copied ? <IconCheck /> : <IconCopy />}
        </button>
      </div>
      <pre className="oc-msg__source-pre">{raw.length > 0 ? raw : "(aucun texte)"}</pre>
    </div>
  );
}

// Toggle between the rendered message and its raw source.
function SourceToggleButton({
  active,
  onToggle,
}: {
  active: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className={`oc-iconbtn${active ? " is-on" : ""}`}
      onClick={onToggle}
      aria-pressed={active}
      title={active ? "Afficher le message rendu" : "Afficher la source (texte brut exact)"}
      aria-label="Afficher la source du message"
    >
      <Code size={15} aria-hidden />
    </button>
  );
}

// User turn: subtle right-aligned bubble + a hover/last-visible action bar with a
// delete (deleting a user turn removes it + every following turn — confirmed).
function UserMessage() {
  const [showSource, setShowSource] = useState(false);
  const ui = useUiPrefs();
  return (
    <MessagePrimitive.Root className="oc-msg oc-msg--user">
      <div className="oc-msg__col oc-msg__col--user">
        <div className="oc-msg__bubble">
          {showSource ? (
            <MessageSource />
          ) : (
            <MessagePrimitive.Parts components={plainComponents} />
          )}
        </div>
        <ActionBarPrimitive.Root
          className="oc-msg__actions oc-msg__actions--user"
          hideWhenRunning
          autohide="not-last"
        >
          {ui.copyUser ? (
            <ActionBarPrimitive.Copy className="oc-iconbtn" title="Copier le message">
              <MessagePrimitive.If copied>
                <IconCheck />
              </MessagePrimitive.If>
              <MessagePrimitive.If copied={false}>
                <IconCopy />
              </MessagePrimitive.If>
            </ActionBarPrimitive.Copy>
          ) : null}
          {ui.showSource ? (
            <SourceToggleButton
              active={showSource}
              onToggle={() => setShowSource((s) => !s)}
            />
          ) : null}
          {ui.showReport ? <FeedbackButton /> : null}
          {ui.showDelete ? <DeleteMessageButton kind="user" /> : null}
        </ActionBarPrimitive.Root>
      </div>
    </MessagePrimitive.Root>
  );
}

// Assistant turn: NO background bubble — content sits on the page background and
// fills the readable column (Open WebUI style). An avatar + name header carries
// the identity; RunStatus shows the live status (and hides itself when done).
function AssistantMessage() {
  const [showSource, setShowSource] = useState(false);
  const ui = useUiPrefs();
  return (
    <MessagePrimitive.Root className="oc-msg oc-msg--assistant">
      <div className="oc-msg__avatar" aria-hidden>
        OC
      </div>
      <div className="oc-msg__col">
        <div className="oc-msg__name">OpenClaw</div>
        <div className="oc-msg__body">
          {showSource ? (
            <MessageSource />
          ) : (
            <MessagePrimitive.Parts components={assistantComponents} />
          )}
          <RunStatus />
        </div>
        {/* Per-message actions, hidden while a turn runs + revealed on hover for
            non-last turns (always shown on the last). Copy + Delete. Deleting an
            assistant turn truncates from here and REGENERATES the last user turn
            (see messages.deleteMessage) — no confirm (recoverable). */}
        <ActionBarPrimitive.Root
          className="oc-msg__actions"
          hideWhenRunning
          autohide="not-last"
        >
          {ui.copyAssistant ? (
            <ActionBarPrimitive.Copy className="oc-iconbtn" title="Copier la réponse">
              <MessagePrimitive.If copied>
                <IconCheck />
              </MessagePrimitive.If>
              <MessagePrimitive.If copied={false}>
                <IconCopy />
              </MessagePrimitive.If>
            </ActionBarPrimitive.Copy>
          ) : null}
          {ui.showSource ? (
            <SourceToggleButton
              active={showSource}
              onToggle={() => setShowSource((s) => !s)}
            />
          ) : null}
          {ui.showReport ? <FeedbackButton /> : null}
          {ui.showDelete ? <DeleteMessageButton kind="assistant" /> : null}
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
  unavailable = false,
}: {
  showTools: boolean;
  onToggleTools: () => void;
  /** Bridge down: disable input + send so no un-sendable turn is persisted. */
  unavailable?: boolean;
}) {
  // Voice-input feature flag: resolved via the UI-preferences module (gated by
  // system enablement + the user's override). The mic only renders when true.
  const voiceInput = useUiPrefs().voiceInput;
  // Unified composer card (per Olivier's reference): the input sits ON TOP, with
  // a single action bar BELOW it — attach (+) and the tools toggle on the left,
  // the circular send (or stop while running) on the right. The CARD owns the
  // border + focus ring (`:focus-within`), so focusing the textarea never shifts
  // layout. (Voice/dictation mic intentionally omitted until the talk.* phase —
  // a non-functional control would mislead.)
  return (
    <ComposerPrimitive.Root
      className={`oc-composer${unavailable ? " oc-composer--disabled" : ""}`}
    >
      <ComposerPrimitive.Attachments components={{}} />
      {/* Content fidelity: disable the browser/OS conventions that MUTATE typed
          text (autocorrect, auto-capitalize, autocomplete) so a word is sent
          exactly as typed — never silently swapped at submit. `data-gramm`
          disables Grammarly. spellCheck stays ON (it underlines, it does NOT
          mutate). NB: no third-party extension is 100% controllable — the
          per-message "Source" view is the real, convention-free guarantee. */}
      <ComposerPrimitive.Input
        className="oc-composer__input"
        placeholder={
          unavailable ? "Chat indisponible…" : "Message OpenClaw…"
        }
        autoFocus
        rows={1}
        disabled={unavailable}
        autoCorrect="off"
        autoCapitalize="off"
        autoComplete="off"
        data-gramm="false"
        data-gramm_editor="false"
        data-enable-grammarly="false"
      />
      <div className="oc-composer__bar">
        <div className="oc-composer__group">
          <ComposerPrimitive.AddAttachment
            className="oc-composer__icon"
            aria-label="Joindre un fichier"
          >
            <Plus size={18} aria-hidden />
          </ComposerPrimitive.AddAttachment>
          <button
            type="button"
            className={`oc-composer__tools${showTools ? " is-on" : ""}`}
            onClick={onToggleTools}
            aria-pressed={showTools}
            title={
              showTools
                ? "Masquer les outils exécutés par OpenClaw"
                : "Afficher les outils exécutés par OpenClaw"
            }
          >
            <SlidersHorizontal size={15} aria-hidden />
            Outils
          </button>
        </div>
        <div className="oc-composer__group">
          {voiceInput ? (
            <button
              type="button"
              className="oc-composer__icon"
              title="Dictée vocale — bientôt disponible"
              aria-label="Dictée vocale (bientôt disponible)"
            >
              <Mic size={18} aria-hidden />
            </button>
          ) : null}
          {unavailable ? (
            // Greyed, non-clickable send: the bridge is down, so persisting a
            // turn would only produce an unanswerable message.
            <button
              type="button"
              className="oc-composer__send"
              disabled
              aria-label="Envoi indisponible (service de chat hors ligne)"
            >
              <ArrowUp size={18} aria-hidden />
            </button>
          ) : (
            <>
              <ThreadPrimitive.If running={false}>
                <ComposerPrimitive.Send className="oc-composer__send" aria-label="Envoyer">
                  <ArrowUp size={18} aria-hidden />
                </ComposerPrimitive.Send>
              </ThreadPrimitive.If>
              <ThreadPrimitive.If running>
                <ComposerPrimitive.Cancel className="oc-composer__stop" aria-label="Arrêter la génération">
                  <Square size={15} aria-hidden />
                </ComposerPrimitive.Cancel>
              </ThreadPrimitive.If>
            </>
          )}
        </div>
      </div>
    </ComposerPrimitive.Root>
  );
}
