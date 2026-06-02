# Convex + assistant-ui chat wiring

New, self-contained frontend wiring for the OpenClaw webchat migration. These
files **do not modify** the existing `frontend/src/App.tsx`. They mount a new
chat surface backed by a reactive Convex query.

## Why NOT useChat / HTTP transport

We use `useExternalStoreRuntime` backed by `useQuery(api.messages.listByChat)`.
We explicitly **do not** use the AI SDK `useChat` default HTTP transport
(POST + SSE per turn). That transport opens a request-scoped stream per turn and
closes it when the turn "ends" — which drops post-turn OpenClaw events (late
tool calls, late media, status corrections). That is the Open WebUI failure mode
this project exists to eliminate.

Instead: the **bridge worker** holds the persistent OpenClaw operator WebSocket,
runs the normalizer, and writes every normalized event into Convex. The browser
is reactive to the **Convex DB only**:

```
OpenClaw WS ──> bridge worker (normalizer) ──> Convex DB patch/insert
                                                    │ (reactive)
                                              useQuery(listByChat)
                                                    │
                                              convertMessage
                                                    │
                                              assistant-ui re-render
```

Streaming = `ctx.db.patch(messageId, {text})` on the server; the browser just
re-renders. Post-turn events land the exact same way.

## Files

| File | Role |
| --- | --- |
| `useConvexChatRuntime.ts` | Builds `useExternalStoreRuntime({messages, isRunning, convertMessage, onNew, adapters:{attachments}})`. `messages` from `useQuery(api.messages.listByChat)`; `isRunning` = any message `status === "streaming"`; `onNew` -> `useMutation(api.send.sendMessage)`. |
| `convertMessage.ts` | Maps a Convex message + ordered parts -> `ThreadMessageLike` (`text` + `tool-call` + `file` + `reasoning`). |
| `attachmentAdapter.ts` | assistant-ui attachment adapter that uploads via `api.send.generateUploadUrl` -> POST bytes -> stores the `_storage` id for `sendMessage`. |
| `ConvexChat.tsx` | `AssistantRuntimeProvider` + `Thread` with custom renderers; sign-out via Convex Auth. |
| `ConvexChatApp.tsx` | New app shell: Convex Auth boundary, chat sidebar, selects `chatId`. |
| `RunStatus.tsx` | Renders `run.status {status, runId}` from message `status`/`runId`. |
| `ToolCard.tsx` | Renders `tool.status {name, phase}` from `tool-call` content parts. |
| `MediaPart.tsx` | Renders `media {items}` -> `file` parts; `<audio>` for TTS, inline image/video, download fallback. |
| `convexTypes.ts` | Client-side document/part types (browser-safe fields only). |
| `convexApi.ts` | Single import indirection for the Convex generated `api`/`Id`. **Adjust the relative path here** if your `convex/` folder is not at the repo root. |
| `convexChat.css` | Styles for the above. |

## Mounting (in `main.tsx`, not edited here)

```tsx
import { ConvexReactClient } from "convex/react";
import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { ConvexChatApp } from "./chat/ConvexChatApp";
import "./chat/convexChat.css";

const convex = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL);

createRoot(document.getElementById("root")!).render(
  <ConvexAuthProvider client={convex}>
    <ConvexChatApp />
  </ConvexAuthProvider>,
);
```

## Server contract assumed (implement in `convex/`)

These functions are referenced by name; implement them server-side with
**per-user authorization** (`ctx.auth.getUserIdentity()`), scoping every read to
the caller's own chats/messages:

- `query  api.messages.listByChat({ chatId })` — returns each message **joined
  with its ordered `messageParts`** and with media/file parts carrying a
  **resolved `url`** (server-side `ctx.storage.getUrl`) instead of a raw
  storageId. Must verify the chat belongs to the caller.
- `mutation api.send.sendMessage({ chatId, text, attachmentIds })` — inserts the
  user message + an `outbox` row for the bridge to forward; verifies ownership.
- `mutation api.send.generateUploadUrl()` — `return await ctx.storage.generateUploadUrl()`; auth-gated.
- `query  api.chats.listMine({})`, `mutation api.chats.create({ title })`.

## Security invariants honoured by the client

- The browser only ever holds opaque Convex storage ids + temporary signed URLs;
  never gateway tokens, device identities, deploy/service keys, or server
  filesystem paths.
- Storage deletion is never done from the browser (no service key); orphaned
  uploads are GC'd by a server cron.
- All data is scoped server-side to the authenticated user.

## Dependencies to add

```
npm i @assistant-ui/react convex @convex-dev/auth
```
