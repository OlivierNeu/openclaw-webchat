import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { onAuthStateChanged, type User } from "firebase/auth";
import { auth, loginWithGoogle, logout } from "./firebase";

type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  ts?: number;
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

function textFromContent(content: unknown): string {
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

function textFromMessage(message: Record<string, unknown> | undefined): string {
  if (!message) {
    return "";
  }
  return textFromContent(message.content ?? message.text);
}

function textFromToolMessage(data: Record<string, unknown>): string {
  const args = data.args as Record<string, unknown> | undefined;
  const result = data.result as Record<string, unknown> | undefined;
  const text = textFromContent(
    args?.message ??
      args?.text ??
      args?.content ??
      data.message ??
      data.text ??
      data.content ??
      result?.message ??
      result?.text ??
      result?.content
  );
  const mediaText = textFromContent(
    data.mediaUrls ?? data.media_urls ?? result?.mediaUrls ?? result?.media_urls
  );
  return [text, mediaText].filter(Boolean).join("\n");
}

function appendOrReplace(
  messages: ChatMessage[],
  message: ChatMessage
): ChatMessage[] {
  const index = messages.findIndex((item) => item.id === message.id);
  if (index === -1) {
    return [...messages, message];
  }
  const next = [...messages];
  next[index] = message;
  return next;
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

function appendAssistantDelta(
  messages: ChatMessage[],
  id: string,
  delta: string
): ChatMessage[] {
  const index = messages.findIndex((item) => item.id === id);
  if (index === -1) {
    return [...messages, { id, role: "assistant", text: delta, ts: Date.now() }];
  }
  const next = [...messages];
  next[index] = {
    ...next[index],
    text: `${next[index].text}${delta}`,
    ts: Date.now()
  };
  return next;
}

function safeHref(href: string): string | null {
  try {
    const url = new URL(href, window.location.origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    return href;
  } catch {
    return null;
  }
}

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
    const safe = safeHref(href);
    if (safe) {
      nodes.push(
        <a
          key={`${safe}-${match.index}`}
          href={safe}
          rel="noreferrer"
          target="_blank"
        >
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

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [chatId, setChatId] = useState(() => {
    return localStorage.getItem("openclaw.chatId") || newChatId();
  });
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [state, setState] = useState<ConnectionState>("signed-out");
  const [status, setStatus] = useState("");
  const socketRef = useRef<WebSocket | null>(null);
  const bridgeErrorRef = useRef(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);

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
        const socket = socketRef.current;
        socketRef.current = null;
        socket?.close();
        bridgeErrorRef.current = false;
        setState("signed-out");
        setStatus("");
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
  }, [messages, status]);

  async function connect() {
    const token = devToken || (user ? await user.getIdToken() : "");
    if (!token) {
      setStatus("Connecte-toi avec Google.");
      return;
    }
    socketRef.current?.close();
    bridgeErrorRef.current = false;
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
      const frame = JSON.parse(event.data);
      handleBridgeFrame(frame);
    };
  }

  function handleBridgeFrame(frame: Record<string, unknown>) {
    if (frame.type === "bridge.ready") {
      const target = frame.target as { sessionKey?: string } | undefined;
      setStatus(`Session ${target?.sessionKey ?? ""}`);
      return;
    }
    if (frame.type === "bridge.error") {
      bridgeErrorRef.current = true;
      setState("error");
      setStatus(String(frame.message ?? "Erreur bridge"));
      return;
    }
    if (frame.type === "chat.history") {
      const payload = frame.payload as { messages?: unknown[] };
      const history = Array.isArray(payload?.messages) ? payload.messages : [];
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
    if (frame.type === "chat.send.result") {
      setStatus("OpenClaw traite la demande...");
      return;
    }
    if (frame.type !== "openclaw.frame") {
      return;
    }
    const openclawFrame = frame.frame as Record<string, unknown>;
    const eventType = openclawFrame.event;
    const payload = openclawFrame.payload as Record<string, unknown> | undefined;
    if (!payload) {
      return;
    }
    if (eventType === "chat") {
      const stateValue = payload.state;
      const message = payload.message as Record<string, unknown> | undefined;
      const id = String(payload.runId ?? "assistant-current");
      const snapshotText = textFromMessage(message);
      if (snapshotText) {
        setMessages((current) =>
          appendOrReplace(current, {
            id,
            role: "assistant",
            text: snapshotText,
            ts: Date.now()
          })
        );
      } else if (typeof payload.deltaText === "string" && payload.deltaText) {
        setMessages((current) =>
          appendAssistantDelta(current, id, String(payload.deltaText))
        );
      } else {
        return;
      }
      setStatus(stateValue === "final" ? "OpenClaw a terminé." : "Réponse en cours...");
      return;
    }
    if (eventType === "agent") {
      const stream = payload.stream;
      const data = payload.data as Record<string, unknown> | undefined;
      if (stream === "lifecycle" && data?.phase === "end") {
        setStatus("OpenClaw finalise la réponse...");
      } else if (stream === "tool" && data?.name) {
        const name = String(data.name);
        setStatus(`Outil: ${name}`);
        if (name === "message") {
          const text = textFromToolMessage(data);
          if (text) {
            setMessages((current) =>
              appendOrReplace(current, {
                id: String(payload.runId ?? data.toolCallId ?? "message-tool"),
                role: "assistant",
                text,
                ts: Date.now()
              })
            );
          }
        }
      } else if (stream === "assistant") {
        const id = String(payload.runId ?? "assistant-current");
        if (typeof data?.text === "string") {
          setMessages((current) =>
            appendOrReplace(current, {
              id,
              role: "assistant",
              text: String(data.text),
              ts: Date.now()
            })
          );
        } else if (typeof data?.delta === "string") {
          setMessages((current) =>
            appendAssistantDelta(current, id, String(data.delta))
          );
        }
      }
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
      JSON.stringify({
        type: "chat.send",
        message: text,
        clientMessageId
      })
    );
    setInput("");
    setStatus("Envoi...");
  }

  function startNewChat() {
    socketRef.current?.close();
    const nextId = newChatId();
    setChatId(nextId);
    setMessages([]);
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
            <article key={message.id} className={`message ${message.role}`}>
              <div className="role">{message.role}</div>
              <pre>{renderText(message.text)}</pre>
            </article>
          ))}
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
