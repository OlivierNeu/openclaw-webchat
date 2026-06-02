# Convex + Node/TS Migration — Status

In-place migration of OpenClaw WebChat to **Convex** (DB + auth + storage +
scheduler) + a **Node/TS bridge worker** (holds the persistent OpenClaw operator
WebSocket, runs the normalizer) + an **assistant-ui** frontend
(`useExternalStoreRuntime` over a reactive Convex `useQuery` — no per-turn HTTP
transport). UI stack mirrors claude-monitor: Vite + React 19 + Tailwind v4
(CSS-first) + shadcn/ui (`radix-nova`) + the unified `radix-ui` package.

## VERIFIED WORKING (browser, local Convex :3212)

The full app-layer chain is proven end-to-end in a real browser:

- Convex local (anonymous) on :3212 cohabits with claude-monitor (:3210); Vite on :5174.
- Convex Auth: **Google** (production) + **Anonymous** (dev-only, gated by
  `OPENCLAW_ENABLE_ANON_AUTH=1`). Sign-in flips the `Authenticated` boundary;
  the chat workspace renders; reload stays authenticated.
- Sending a message: composer → `onNew` (passes `clientMessageId` + attachments
  `{storageId,filename,mimeType}`) → `send.sendMessage` mutation → row in
  `messages` (status complete, scoped to the authed `userId`) + `outbox` row with
  the `clientMessageId` and linked `messageId` → reactive `useQuery(listByChat)`
  → `convertMessage` → rendered in the thread. Zero console errors.
- `tsc --noEmit` (root) = clean; `vite build` = clean; bridge `vitest` = 31/31
  (23 proven normalizer + 8 run-manager) + bridge `tsc` clean.

The `outbox` row ends `status: "failed"` — EXPECTED: `bridge.dispatch` tries to
reach the bridge worker, which is not running (no OpenClaw gateway, no
`BRIDGE_URL`). The Convex↔frontend contract is proven; only the bridge→OpenClaw
hop is unwired.

## Local deployment: env vars that MUST be set on :3212

Convex Auth needs these on the deployment (set via `npx convex env set`, NOT in
source). Gotchas hit and resolved:

- `JWT_PRIVATE_KEY` — RS256 private key in **PKCS8 with REAL newlines**. Setting
  it with literal `\n` (two chars) makes jose's `importPKCS8` throw
  `atob: Invalid byte 92`. Set it via `npx convex env set --from-file <dotenv>`
  with the value double-quoted and containing actual newlines.
- `JWKS` — the public JWKS as **raw JSON** (`{"keys":[...]}`). Do NOT
  `JSON.stringify` an already-JSON string into the dotenv (double-encoding ->
  `{\"keys\"...}` served at `.well-known/jwks.json` -> token validation fails
  silently: sign-in returns 200 and refreshes, but `isAuthenticated` never flips).
- `SITE_URL` — issuer origin, `http://127.0.0.1:3213` locally (matches the token
  `iss` and `auth.config.ts` `domain`).
- `OPENCLAW_ENABLE_ANON_AUTH=1` — enables the dev Anonymous provider.

Keys were generated locally with `jose` (RS256), set on the deployment, never
committed. Google creds (`AUTH_GOOGLE_ID/SECRET`) are for production only.

## Run it

```bash
./dev.sh                 # convex dev (:3212) + vite (:5174), safe for multi-project
# sign in with "Continue (dev, no account)", create a chat, send a message
```

## File inventory (integrated)

```
convex/  schema.ts auth.ts auth.config.ts http.ts(=auth routes + /bridge/ingest)
         chats.ts messages.ts send.ts stream.ts uploads.ts bridge.ts bridge_ingest.ts lib/access.ts
src/     main.tsx(ConvexAuthProvider) App.tsx index.css lib/utils.ts components/ui/*
  chat/  ConvexChatApp.tsx ConvexChat.tsx useConvexChatRuntime.ts convertMessage.ts
         convexTypes.ts convexApi.ts attachmentAdapter.ts RunStatus.tsx ToolCard.tsx MediaPart.tsx convexChat.css
bridge/  src/{normalizer,sanitize (PROVEN), openclaw-client, run-manager, session,
         session-keys, convex-writer, server, config, index}.ts  test/{normalizer,run-manager}.test.ts
```

The legacy `frontend/` (workflow-1 React) and `backend/` (FastAPI) remain for
reference; remove once the Convex path is fully wired. The Python normalizer +
the 12 fixtures stay as the executable regression spec for the TS port.

## KNOWN-OPEN (tracked, not blocking text streaming)

- **Bridge worker not yet wired to a live OpenClaw gateway** — the worker code
  exists (`bridge/src/*`, 31/31 tests) but needs: env (`bridge/.env.example`),
  the Convex ingest secret, and a reachable OpenClaw gateway. Until then, sends
  land in `outbox` as `failed`. This is the next milestone.
- **Attachments end-to-end**: `outbox.attachmentIds` are raw `_storage` ids; the
  bridge must resolve them to bytes/path for the gateway (red-team blocker).
- **Bridge ordering**: `startAssistant` + arm the normalizer must happen BEFORE
  `chat.send`, seeding `runId` from the ack after (red-team blocker — apply when
  wiring the live worker; the offline run-manager test can't see the race).
- **Media-OUT serving + unbounded inbound frame queue** (bridge red-team).
- **`listChats` still uses `.collect()`** (bounded in practice; switch to a
  `(userId, updatedAt)` index + `.take()`).
- **IDOR registerUpload** hardened to reject a storageId already owned by another
  user; threat model is defense-in-depth atop storage-id unguessability.
- **No pagination/scrollback** beyond `listByChat`'s most-recent-200 window.
- **assistant-ui 0.14 API**: chat components were adapted from the workflow-1
  drafts (`MessagePrimitive.Parts`, local ToolCard props) — re-verify on any
  assistant-ui upgrade.

## Next milestone

Wire the bridge worker to a live OpenClaw gateway and the Convex ingest endpoint,
then verify token-by-token streaming in the browser (assistant bubble grows as
`appendDelta` patches the doc). Apply the two bridge red-team blockers during
that wiring.
