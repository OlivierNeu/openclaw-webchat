import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { onAuthStateChanged, type User } from "firebase/auth";
import { auth, loginWithGoogle, logout } from "./firebase";
import {
  applyStreamEvent,
  safeHref,
  statusLabel,
  textFromContent,
  type MediaItem,
  type Streaming
} from "./bridge";

type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  ts?: number;
  error?: boolean;
  media?: MediaItem[];
};

type ConnectionState =
  | "signed-out"
  | "connecting"
  | "connected"
  | "disconnected"
  | "error";

function newChatId(): string {
  return crypto.randomUUID();
}

function wsUrl(chatId: string): string {
  const configured = import.meta.env.VITE_OPENCLAW_BRIDGE_WS_URL as string | undefined;
  if (configured) {
    const normalized = configured
      .replace(/^https:\/\//, "wss://")
      .replace(/^http:\/\//, "ws://")
      .replace(/\/$/, "");
    return `${normalized}/ws/chats/${chatId}`;
  }
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws/chats/${chatId}`;
}

function mergeMessages(current: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const byId = new Map<string, ChatMessage>();
  for (const message of incoming) {
    byId.set(message.id, message);
  }
  for (const message of current) {
    if (!byId.has(message.id)) {
      byId.set(message.id, message);
    }
  }
  return Array.from(byId.values()).sort((left, right) => {
    return (left.ts ?? 0) - (right.ts ?? 0);
  });
}

// Render plain text with safe markdown/auto links only. The bridge already
// sanitizes server paths and signs media URLs; we still refuse non-http(s)
// schemes so a crafted link cannot smuggle javascript:/data: targets.
function renderText(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /\[([^\]]+)\]\(([^)]+)\)|(https?:\/\/[^\s)]+)/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > cursor) {
      nodes.push(text.slice(cursor, match.index));
    }
    const label = match[1] ?? match[3] ?? "";
    const href = match[2] ?? match[3] ?? "";
    const safe = safeHref(href, window.location.origin);
    if (safe) {
      nodes.push(
        <a key={`${safe}-${match.index}`} href={safe} rel="noreferrer" target="_blank">
          {label}
        </a>
      );
    } else {
      nodes.push(label);
    }
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) {
    nodes.push(text.slice(cursor));
  }
  return nodes;
}

function MessageMedia({ media }: { media?: MediaItem[] }): ReactNode {
  if (!media || media.length === 0) {
    return null;
  }
  return (
    <ul className="media">
      {media.map((item) => {
        const safe = item.url ? safeHref(item.url, window.location.origin) : null;
        return (
          <li key={item.filename}>
            📎{" "}
            {safe ? (
              <a href={safe} rel="noreferrer" target="_blank">
                {item.filename}
              </a>
            ) : (
              item.filename
            )}
          </li>
        );
      })}
    </ul>
  );
}

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [chatId, setChatId] = useState(() => {
    return localStorage.getItem("openclaw.chatId") || newChatId();
  });
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState<Streaming | null>(null);
  const [input, setInput] = useState("");
  const [state, setState] = useState<ConnectionState>("signed-out");
  const [status, setStatus] = useState("");
  const socketRef = useRef<WebSocket | null>(null);
  const bridgeErrorRef = useRef(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  // Authoritative streaming value, read/written synchronously inside the frame
  // handler to avoid stale-closure bugs; mirrored into state for rendering.
  const streamingRef = useRef<Streaming | null>(null);

  const devToken = import.meta.env.VITE_DEV_ID_TOKEN as string | undefined;

  useEffect(() => {
    if (!auth) {
      if (devToken) {
        setState("disconnected");
      }
      return;
    }
    return onAuthStateChanged(auth, (nextUser) => {
      setUser(nextUser);
      if (!nextUser && !devToken) {
        // Sign-out must tear down the live socket immediately.
        const socket = socketRef.current;
        socketRef.current = null;
        socket?.close();
        bridgeErrorRef.current = false;
        setState("signed-out");
        setStatus("");
        resetStreaming();
      }
    });
  }, [devToken]);

  useEffect(() => {
    localStorage.setItem("openclaw.chatId", chatId);
  }, [chatId]);

  const displayName = useMemo(() => {
    return user?.displayName || user?.email || "Mode dev";
  }, [user]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, streaming, status]);

  function resetStreaming() {
    streamingRef.current = null;
    setStreaming(null);
  }

  async function connect() {
    const token = devToken || (user ? await user.getIdToken() : "");
    if (!token) {
      setStatus("Connecte-toi avec Google.");
      return;
    }
    socketRef.current?.close();
    bridgeErrorRef.current = false;
    resetStreaming();
    setState("connecting");
    setStatus("Connexion OpenClaw...");
    const socket = new WebSocket(wsUrl(chatId));
    socketRef.current = socket;
    socket.onopen = () => {
      if (socketRef.current !== socket) {
        return;
      }
      setState("connected");
      setStatus("Authentification...");
      socket.send(JSON.stringify({ type: "auth", idToken: token }));
    };
    socket.onclose = () => {
      if (socketRef.current !== socket) {
        return;
      }
      if (bridgeErrorRef.current) {
        return;
      }
      setState("disconnected");
      setStatus("Déconnecté. Reconnecte pour récupérer l’historique.");
    };
    socket.onerror = () => {
      if (socketRef.current !== socket) {
        return;
      }
      setState("error");
      setStatus("Erreur WebSocket.");
    };
    socket.onmessage = (event) => {
      if (socketRef.current !== socket) {
        return;
      }
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(event.data);
      } catch {
        return;
      }
      handleBridgeFrame(frame);
    };
  }

  function handleBridgeFrame(frame: Record<string, unknown>) {
    switch (frame.type) {
      case "bridge.ready": {
        const target = frame.target as { sessionKey?: string } | undefined;
        setStatus(`Session ${target?.sessionKey ?? ""}`);
        return;
      }
      case "bridge.error": {
        const fatal = frame.fatal !== false; // default to fatal for safety
        setStatus(String(frame.message ?? "Erreur bridge"));
        if (fatal) {
          bridgeErrorRef.current = true;
          setState("error");
        }
        return;
      }
      case "bridge.warning":
        setStatus(String(frame.message ?? "Avertissement bridge"));
        return;
      case "chat.history": {
        const payload = frame.payload as { messages?: unknown[] } | undefined;
        const history = Array.isArray(payload?.messages) ? payload!.messages : [];
        const mapped = history
          .map((item, index) => {
            const raw = item as Record<string, unknown>;
            return {
              id: String(raw.id ?? `history-${index}`),
              role: raw.role === "user" ? "user" : "assistant",
              text: textFromContent(raw.content ?? raw.text ?? raw.message),
              ts: typeof raw.ts === "number" ? raw.ts : undefined
            } satisfies ChatMessage;
          })
          .filter((item) => item.text);
        setMessages((current) => mergeMessages(current, mapped));
        return;
      }
      case "chat.send.result":
        setStatus("OpenClaw traite la demande...");
        return;
      case "chat.abort.result":
        setStatus("Demande d’interruption envoyée.");
        return;
      case "tool.status":
        if (frame.phase === "start" && frame.name) {
          setStatus(`Outil : ${String(frame.name)}`);
        }
        return;
      case "message.delta":
      case "message.snapshot":
      case "message.final":
      case "media":
      case "run.status": {
        if (frame.type === "run.status") {
          const label = statusLabel(frame.status);
          if (label) {
            setStatus(label);
          }
        }
        const update = applyStreamEvent(streamingRef.current, frame);
        if (update.final) {
          const { text, error, media } = update.final;
          setMessages((current) => [
            ...current,
            {
              id: crypto.randomUUID(),
              role: "assistant",
              text,
              ts: Date.now(),
              error,
              media: media.length ? media : undefined
            }
          ]);
        }
        streamingRef.current = update.streaming;
        setStreaming(update.streaming);
        return;
      }
      // "openclaw.frame" is a deprecated raw passthrough; the UI ignores it.
      default:
        return;
    }
  }

  function sendMessage() {
    const text = input.trim();
    if (!text || socketRef.current?.readyState !== WebSocket.OPEN) {
      return;
    }
    const clientMessageId = crypto.randomUUID();
    setMessages((current) => [
      ...current,
      { id: clientMessageId, role: "user", text, ts: Date.now() }
    ]);
    socketRef.current.send(
      JSON.stringify({ type: "chat.send", message: text, clientMessageId })
    );
    setInput("");
    setStatus("Envoi...");
  }

  function abortRun() {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ type: "chat.abort" }));
    }
  }

  function startNewChat() {
    socketRef.current?.close();
    const nextId = newChatId();
    setChatId(nextId);
    setMessages([]);
    resetStreaming();
    setStatus("Nouvelle conversation créée.");
  }

  return (
    <main className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="mark">OI</span>
          <div>
            <strong>OpenClaw WebChat</strong>
            <span>{displayName}</span>
          </div>
        </div>
        <button onClick={startNewChat}>New Chat</button>
        <button onClick={connect} disabled={!user && !devToken}>
          Reconnect / Sync
        </button>
        <button
          onClick={abortRun}
          disabled={socketRef.current?.readyState !== WebSocket.OPEN}
        >
          Stop
        </button>
        {user || devToken ? (
          <button onClick={() => logout()}>Sign out</button>
        ) : (
          <button onClick={() => loginWithGoogle()}>Sign in with Google</button>
        )}
        <div className={`state state-${state}`}>{state}</div>
        <code>{chatId}</code>
      </aside>
      <section className="chat">
        <header>
          <h1>OpenClaw Gateway</h1>
          <span>{status}</span>
        </header>
        <div className="messages">
          {messages.map((message) => (
            <article
              key={message.id}
              className={`message ${message.role}${message.error ? " error" : ""}`}
            >
              <div className="role">{message.role}</div>
              <pre>{renderText(message.text)}</pre>
              <MessageMedia media={message.media} />
            </article>
          ))}
          {streaming ? (
            <article className="message assistant streaming">
              <div className="role">assistant</div>
              <pre>{renderText(streaming.text)}</pre>
              <MessageMedia media={streaming.media} />
            </article>
          ) : null}
          <div ref={bottomRef} />
        </div>
        <footer>
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                sendMessage();
              }
            }}
            placeholder="Écris un message..."
          />
          <button
            onClick={sendMessage}
            disabled={socketRef.current?.readyState !== WebSocket.OPEN}
          >
            Send
          </button>
        </footer>
      </section>
    </main>
  );
}

export default App;
