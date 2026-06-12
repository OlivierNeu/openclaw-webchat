# OpenClaw v2026.5.19 — Protocol & Streaming Research

> **Intended path:** `docs/OPENCLAW_RESEARCH.md`
> **Scope:** ground-truth research feeding the modular/multi-provider/multi-tenant bridge
> design. Pinned target: **OpenClaw v2026.5.19** (multi-version support is out of scope).
> **Authority order:** in-repo normalizer + 12 fixtures + bridge code = ground truth;
> the public OpenClaw doc is supplementary and, where it diverges, the fixtures win.

## TL;DR

OpenClaw is a **real, verifiable** project: `github.com/openclaw/openclaw` exists (GitHub API
id `1103012935`, MIT, TypeScript) and the pinned tag **`v2026.5.19` is confirmed from primary
source** (HTTP 200, sha `dc44220d5289c2777c9db7e47eeb1cf60bf9e49c`), with a 803-line
`docs/gateway/protocol.md` at that tag. But the design **cannot be driven from the public doc
alone**: several load-bearing behaviors (the `agent` event family, `payload.state` as the
turn-end signal, the dedup rule, the `webchat:chat:<canonical>:<chatId>` sessionKey grammar,
the bare `{event,payload}` envelope) exist **only** in the in-repo normalizer + fixtures and
have **no public-doc counterpart** — so the 737-line `bridge/src/normalizer.ts` and the 12
fixtures in `backend/tests/fixtures/openclaw_frames.json` are the authoritative provider
contract. The bridge today makes exactly four gateway calls (`connect`, `sessions.patch`,
`chat.send`, and a synthesized abort-on-close); a **conversation-list / `chat.history` call is
NOT implemented** (it appears only in comments) — the task's "incl. conversation list" is a
documented-but-unverified gap, not an existing surface. Hermes (the second provider) is an
**OpenAI-compatible HTTP/SSE server** that maps cleanly onto the same normalized vocabulary
but is single-key (not per-user), inline-images-only, and unpinned. On streaming: the common
premise that "the bridge persists each token via a mutation" is **already false** — deltas are
coalesced (~50 ms) before persistence (`convex-writer.ts`); the real bottleneck is structural
(**the live display path *is* the persistence path**), which is the thing the redesign must
decouple.

## Sources & confidence

| # | Source | What it grounds | Tier | Confidence |
|---|--------|-----------------|------|------------|
| S1 | `bridge/src/normalizer.ts` (in-repo, ported from proven Python, 23 passing tests) | Normalized vocabulary, isolation gate, turn-end state machine, media shape | verified-in-repo | **High** |
| S2 | `backend/tests/fixtures/openclaw_frames.json` (12 scenarios) | Real frame shapes (`agent`/`chat`/`health`), sessionKey grammar, dedup/grace behavior | verified-in-repo | **High** |
| S3 | `bridge/src/openclaw-client.ts` | Handshake (Ed25519), connect request, `request()`/`res` correlation, idempotencyKey | verified-in-repo | **High** |
| S4 | `bridge/src/session-keys.ts` | `agent:<agentId>:webchat:chat:<canonical>:<chatId>` grammar | verified-in-repo | **High** |
| S5 | `bridge/src/server.ts` + `run-manager.ts` + `convex-writer.ts` | Gateway calls actually made; event→Convex mapping; delta coalescing | verified-in-repo | **High** |
| S6 | `https://api.github.com/repos/openclaw/openclaw/git/refs/tags/v2026.5.19` | Version pin exists (sha `dc44220…`) | verified-primary-web | **High** |
| S7 | `https://raw.githubusercontent.com/openclaw/openclaw/v2026.5.19/docs/gateway/protocol.md` (803 lines) | WS protocol v4, connect/device handshake, `chat`/`deltaText`, roles/scopes | verified-primary-web | **High** (existence) / **Medium** (completeness) |
| S8 | `docs/tools/subagents.md` @ tag | Subagent key grammar `agent:<agentId>:subagent:<uuid>` | verified-primary-web | **High** |
| S9 | OpenClaw search-engine prose | (rejected) invented `docs/gateway/security.md`, fabricated Ed25519 byte format | unreliable-web | **Low / distrust** |
| S10 | `github.com/NousResearch/hermes-agent` + `api-server.md` + `gateway/platforms/api_server.py` | Hermes HTTP/SSE surface, sessions API, runs lifecycle | primary-web (single-source on specifics) | **Medium** |
| S11 | Hermes third-party docs / issues (#9794, #9777, #8993) | Open WebUI tool-UX failure mode; version drift (v0.2.0 vs v0.8.0) | secondary-web | **Low** |
| S12 | `docs/BRIDGE_PROTOCOL.md` (in-repo) | Browser-facing contract — **partly stale** (see §6) | in-repo (mixed) | **Mixed** |
| — | Conversation-list / `chat.history` request/response shapes | (the task's "incl. conversation list") | — | **NOT FOUND** |

> **Anomaly, recorded not chased (S6 area):** the repo reports ~376k stars, anomalously high
> for a TS assistant absent from a Jan-2026 knowledge cutoff. Existence + tag + raw doc content
> are independently verified; treat **popularity/adoption metrics as unverified**.

---

## 1. OpenClaw v2026.5.19 documentation: public vs in-repo-only

### Public (verified at the pinned tag)
- **Repo & version pin — verified from primary source** (S6): tag `refs/tags/v2026.5.19`
  resolves (sha `dc44220d5289c2777c9db7e47eeb1cf60bf9e49c`); neighbors `v2026.5.18`,
  `v2026.5.19-alpha.1/-beta.1/-beta.2`, `v2026.5.20` also exist.
- **Docs are versioned in-repo at the tag** and mirrored at `docs.openclaw.ai` (S7): notably
  `gateway/protocol.md` (803 lines), plus `gateway/pairing.md`,
  `gateway/trusted-proxy-auth.md`, `gateway/authentication.md` (**model-provider auth, NOT
  gateway-connection auth**), `concepts/session.md`, `concepts/multi-agent.md`,
  `concepts/delegate-architecture.md`, `tools/subagents.md`, `reference/device-models.md`,
  `web/webchat.md`.
- **What the public doc confirms** (anchors the abstraction): WS text+JSON frames; first frame
  must be a connect request; device-identity handshake `device:{id,publicKey,signature,
  signedAt,nonce}` signed against a `connect.challenge` nonce; roles + scopes
  (`operator.read/write/admin`); protocol **v4** `chat` payloads carry `deltaText` with a
  cumulative `message` snapshot and `replace=true` semantics; subagent session keys
  `agent:<agentId>:subagent:<uuid>` (S8).

### In-repo-only (no public-doc counterpart — fixtures/normalizer are authoritative)
These are the riskiest things to design from docs alone; **do not** treat the public doc as
complete here:
1. **The `agent` event family** (`{event:"agent", payload:{stream:"assistant", data:{text|delta}}}`)
   is in the fixtures (the dominant content path for the legacy 5.7 surface and for media/tool
   streams) but is **ABSENT** from `protocol.md`'s enumerated event families.
2. **`payload.state = "delta" | "final"` as the turn-end signal** — `protocol.md` documents
   `deltaText`/snapshot/`replace` but **not** state-as-turn-end, **not** "an empty final is NOT
   turn-end," and **not** the dedup rule.
3. **The dedup key** = `(runId, seq, state, deltaText, content-fingerprint)` — fixture/normalizer
   only (S1 `normalizer.ts` ~L405; S2 `duplicate-final`, `duplicate-empty-final`).
4. **The webchat sessionKey grammar** `agent:<agentId>:webchat:chat:<canonical>:<chatId>`
   (S4; fixture `agent:main:webchat:chat:alice:own-chat`) — only the *subagent* form is
   doc-confirmed; the `webchat:chat:<user>:<chat>` segment is **NOT FOUND** in any fetched doc.
5. **Frame envelope divergence:** the doc wraps events as
   `{type:"event", event, payload, seq?, stateVersion?}`; the captured fixtures are **bare
   `{event, payload}`** with no `type` wrapper. The normalizer reads the bare form
   (`normalizer.ts` L349-355). Whether the gateway omits the wrapper on the webchat path or an
   upstream strips it is **NOT FOUND** — but the bridge transducer must consume the bare form.

---

## 2. Authoritative in-repo OpenClaw protocol surface

### 2.1 Handshake (S3 `openclaw-client.ts`)
WebSocket, text JSON frames. **WS auto-ping is disabled** (the gateway drives keepalive; a
client ping it never answers tears the socket down — load-bearing).

1. **Phase 1 — challenge:** gateway sends `{type:"event", event:"connect.challenge",
   payload:{nonce, ts}}`. `ts` is used **verbatim** (fabricating it yields an unverifiable
   signature). (L177-196)
2. **Sign (Ed25519):** message =
   `"v2" | device.id | "cli" | "cli" | "operator" | <scopes,joined> | String(ts) | token | nonce`
   (pipe-joined), signed with the device private key, **base64url, `=` padding stripped**.
   `clientId="cli"` **and** `clientMode="cli"` are load-bearing: they classify the connection
   as `channel=webchat` (`"web"` lands elsewhere). (`signChallenge`, L76-104)
3. **Phase 2 — connect request:** `{type:"req", id, method:"connect", params:{minProtocol:3,
   maxProtocol:4, client:{id:"cli", version:"1.0.0", platform:"linux", mode:"cli"},
   role:"operator", scopes:[operator.read/write/admin/approvals/pairing], auth:{token},
   device:<signed>, locale:"en-US", userAgent:"openclaw-webchat-bridge/0.1.0",
   caps:["agent-events","tool-events"]}}`. (L198-221)
4. **Connect ack** = a `res` for our `id` with `ok:true`; thereafter the steady-state reader
   correlates `{type:"res", id, ok, payload|error}` by `id` and **never forwards `res` frames**
   to the inbound consumer; non-`res` frames go to `frames()`. (L225-281)

> **Device-identity specifics gap:** the exact pairing/approval flow lives in
> `docs/gateway/pairing.md` + `docs/reference/device-models.md` + the device JSON in the
> bridge's own secret store. Search-engine prose on the signing format was **confabulated and
> must not be trusted** — the canonical signed string above comes from S3 code, not prose.

### 2.2 Gateway API calls

**VERIFIED — actually made by the bridge:**

| Method | Where | Params | Notes |
|--------|-------|--------|-------|
| `connect` | `openclaw-client.ts` L198 | (handshake, §2.1) | once per connection |
| `sessions.patch` | `server.ts` L119-125 | `{key:<sessionKey>, verboseLevel:"full"}` | **once per connection** (sticky server-side); without it tool results & `mediaUrls` are stripped |
| `chat.send` | `server.ts` L127-138 | `{sessionKey, message, idempotencyKey, attachments?}` | run id learned from `response.payload.runId ?? response.runId` |
| *abort* | `session.ts` L79-86 | — | **synthesized locally**: on socket close mid-turn the run-manager finalizes the turn `aborted`. There is **no `chat.abort` RPC call** in the bridge. |

- **idempotencyKey** = `webchat-<sha256(sessionKey|clientMessageId)>` (or `webchat-<uuid>` when
  no clientMessageId), so at-least-once dispatch from Convex never double-sends (S3 L398-410).

**DOCUMENTED-BUT-UNUSED (named in `protocol.md`, not called by the bridge — shapes unverified):**
`chat.history`, `artifacts.list/get/download`, a sessions list/index, `tasks.list`, `cron.*`.

> **Conversation-list — NOT FOUND (honest answer to the task's "incl. conversation list"):**
> the bridge implements **no** conversation-list / history call. `chat.history` appears **only
> in comments** as a deferred fallback (`normalizer.ts` L324, L468); no request/response shape
> exists in repo, and `protocol.md` *names* the method but its params/response were never
> extracted. **Designing a conversation-list feature requires first capturing the real
> `chat.history` (or sessions-index) frame against a live v2026.5.19 gateway.** Do not invent
> the shape.

### 2.3 Normalized event vocabulary (the provider-agnostic contract = the abstraction boundary)
Emitted by the normalizer (S1), consumed by the run-manager (S5). This is the stable seam every
provider must map onto:

| Event | Shape | Meaning |
|-------|-------|---------|
| `message.delta` | `{text}` | append to the in-progress reply (whitespace significant) |
| `message.snapshot` | `{text}` | replace the in-progress reply; later deltas ignored |
| `message.final` | `{text, error?}` | authoritative final text; commit & stop streaming |
| `run.status` | `{status, runId}` | `started\|running\|working\|compacting\|final\|error\|aborted` |
| `tool.status` | `{name, phase, runId}` | in-flight tool visibility |
| `media` | `{items:[{filename, path}], runId}` | outbound files (**`{filename, path}` — NOT a signed URL**, see §6) |
| `openclaw.frame` | `{frame}` | **deprecated** raw sanitized passthrough |

**Isolation gate (one decision for passthrough + normalized; `normalizer.ts` L360-377):**
only `event ∈ {agent, chat}` with object payload pass; `payload.sessionKey` must equal the
session key (foreign-session & sessionless → drop); a `runId` not in `ownRunIds` is dropped
**unless** a `lifecycle_end` grace or compaction is open (legitimate follow-on/replay).

**Turn-end & precedence state machine (fixture-authoritative):**
- `chat` snapshot (`message.content`) → snapshot wins, locks out later deltas; `deltaText` →
  delta; empty `final` is **NOT** turn-end → arms a 90 s grace (`EMPTY_FINAL_GRACE`).
- `agent stream=assistant` `data.text` → snapshot; `data.delta` → delta; `data.mediaUrls` →
  media; `stream=tool` → `tool.status` (+ message-tool visible text); `stream=lifecycle`
  `phase=end` with `livenessState=="abandoned"` → **compaction** (discard partial, emit
  `compacting`), `phase=error` → finalize error.
- **Private-ack suppression:** short "Envoyé./done/ok" finals are held (5 s grace) and never
  persisted as the answer if a real visible message follows.

### 2.4 Cross-reference: normalizer ↔ fixtures
Each fixture protects a regression and pins a real frame shape:

| Fixture | Pins |
|---------|------|
| `chat-final-content` / `-string` | 5.19 `chat` snapshot, `state delta→final`, list-vs-string content |
| `chat-final-empty-then-content` | empty final is NOT turn-end; foreign `health` dropped |
| `duplicate-final` / `duplicate-empty-final` | dedup by `(runId,seq,state,deltaText,content)` |
| `agent-assistant-delta-legacy` | legacy 5.7 `agent`/`data.delta` accumulation |
| `chat-deltatext-spaces` | leading/trailing spaces preserved verbatim |
| `lifecycle-end-then-followon-run` | follow-on run admitted during lifecycle-end grace |
| `compaction-abandoned-replay` / `normal-end-working-replayinvalid` | `abandoned`→reset vs `working+replayInvalid`→normal end |
| `tool-message-visible` / `-external-target-ignored` | message-tool to current chat vs external target |
| `mediaurls-list` / `media-directive` | outbound-path filtering; `MEDIA:` line rewrite |
| `private-ack-then-visible` / `-only` | ack suppression; graceful finalize, never hang |
| `lifecycle-error` | structured error → finalize error |
| `isolation-foreign-session` / `-same-session-foreign-run` / `-sessionless` | the three drop cases |

---

## 3. Hermes interface + mapping to the vocabulary

Hermes (`NousResearch/hermes-agent`, S10) is the second pluggable provider. Unlike OpenClaw's
persistent operator WS + custom frames, Hermes is an **OpenAI-compatible HTTP/SSE server**
(default bind `127.0.0.1:8642`), bearer auth via a **single `API_SERVER_KEY`** (CORS via
`API_SERVER_CORS_ORIGINS`).

**Send paths:** `POST /v1/chat/completions` (OpenAI Chat), `POST /v1/responses` (OpenAI
Responses; server-side state via `previous_response_id`), `POST /v1/runs` (Hermes-native:
`{input, session_id?, instructions?, conversation_history?, previous_response_id?}` → `run_id`;
plus `GET /v1/runs/{id}`, `GET /v1/runs/{id}/events` SSE, `POST /v1/runs/{id}/stop`).

**Conversation-list — YES (this is where Hermes is *better* documented than OpenClaw):**
`GET /api/sessions` (paginated) + `GET /api/sessions/{id}/messages` (history), under
`/api/sessions/*` gated by `API_SERVER_KEY`.

### Mapping onto the normalized vocabulary

| Normalized event | Hermes source |
|------------------|---------------|
| `message.delta` | Chat `chat.completion.chunk`; Responses `response.output_text.delta` |
| `message.snapshot` | Responses `response.output_text.done` / message-level deltas |
| `message.final` | Responses `response.completed`/`.failed`; Chat stream end |
| `run.status` | run lifecycle `started → completed\|failed\|cancelled` (transient `stopping`) → map to `started\|final\|error\|aborted` |
| `tool.status` | Responses `function_call{name,arguments,call_id}` / `function_call_output`; Chat `hermes.tool.progress`; sessions stream `tool.started/completed/failed` |
| `media` | **inline images only** (`image_url`) — no bidirectional binary file channel |
| abort | `POST /v1/runs/{id}/stop` → `{"status":"stopping"}` (halts at next safe point) |

**Design implications & gaps (do not over-claim):**
- **Single-key, NOT per-user** — multi-tenancy must be enforced **by the bridge** (one
  secret-store group per Hermes instance; map each user to a `session_id` /
  `X-Hermes-Session-Id` / `-Session-Key`), mirroring the per-instance OpenClaw secret model.
- **Files/media:** inline images only; non-image / `file_id` → `400 unsupported_content_type`.
  No agent-produced-file channel comparable to OpenClaw's outbound media. **NOT FOUND.**
- **Runs-events SSE vocabulary:** exact event-type strings for `GET /v1/runs/{id}/events` are
  **NOT FOUND** in docs or visible source (the *sessions* chat/stream vocabulary and the
  Responses spec names are known; the runs-events strings are the gap).
- **No version pin:** third-party docs cite v0.2.0, an issue references v0.8.0 — **pin a tested
  Hermes version before relying on exact field names** (S11).
- **Subagents via the API:** whether/how Hermes exposes OpenClaw-style subagents (vs
  skills/toolsets) is **NOT FOUND**.
- **Relevant precedent:** Open WebUI Responses-mode tool-UX gaps (#9794, #9777) are the same
  class of failure the Convex persist-then-render design avoids (§5).

---

## 4. Streaming-pattern research

### 4.1 Diagnosis (evidence-backed; corrects the common premise)
The premise "the bridge persists each token via a mutation" is **already false**:
- **Deltas are coalesced** — `HttpConvexWriter` buffers per-message deltas and flushes **one
  `appendDelta` per ~50 ms** (`deltaFlushMs ?? 50`), or immediately before any non-delta op
  (`convex-writer.ts` L124, L164-194). So a redesign aimed at "fixing per-token mutations"
  targets an already-mitigated problem.
- **The actual coupling:** *the live display path **is** the persistence path.* Tokens reach
  the browser **only** by being persisted: bridge → Convex `.site` ingest HTTP RTT → internal
  mutation txn → `messages.text` patch → search reindex → `listByChat` recompute → `useQuery`
  push. There is **no separate ephemeral/live channel** (`convex-writer.ts` ingest path;
  `stream.appendDelta` does `text = message.text + delta`, an O(n) rewrite per flush, plus the
  `search_text` index reindexes the growing string each patch). Lowering the flush toward
  per-token multiplies every one of these costs.
- **In-flight status & raw frames are dropped, not persisted:** the run-manager drops
  intermediate `run.status` (`working/running/compacting`) and the deprecated `openclaw.frame`
  (`run-manager.ts` L171-184). So the *vocabulary* already carries in-flight tool/run status,
  but it is **not yet durably surfaced** — a forward-looking gap given the task's goal of
  surfacing in-flight tool/run status in the UI.

This diagnosis is exactly the Image-#23 migration premise: *"Persistence + reactivity live in
Convex. No SSE-per-turn that closes."* The job is to **decouple an ephemeral live-token channel
from durable Convex persistence/reactivity** — without losing reconnect/durability.

### 4.2 Recommendation (reasoned design proposal — NOT a finding)
> The repo contains **no** prior crystallized streaming-decouple recommendation (grep of
> `PROJECT_STATE.md`/`ARCHITECTURE.md`/`ROUTING_RESEARCH.md` found none). The following is a
> **design proposal** built on §4.1 + the Image-#23 requirement. **Convex-capability
> assumptions are labeled `[unverified]`** and must be validated against the pinned Convex
> version before implementation.

1. **Two planes, one source of truth.**
   - *Live plane (ephemeral, fluid):* push token deltas over a low-latency channel that does
     **not** rewrite a growing document per token. Candidate: a small per-message
     **append-only "live deltas" structure** (e.g. short-TTL rows / an ephemeral doc the UI
     concatenates client-side) so each delta is an O(1) insert, not an O(n) text rewrite. The
     UI renders `committed_text + Σ(live deltas)`. `[unverified: best Convex primitive — ephemeral
     table vs document-streaming component vs a separate WS relay owned by the bridge.]`
   - *Durable plane (authoritative):* keep persisting **coarsely** — on snapshot, on finalize,
     and on a slow heartbeat (e.g. every N ms or M tokens) — so reconnect/scrollback/search work
     off `messages.text` exactly as today. Finalize collapses the live deltas into the durable
     text and clears the ephemeral structure.
2. **Kill the O(n²)/reindex amplification:** stop patching the full `messages.text` per flush
   on the hot path; only the coarse durable writes touch the searchable field. This removes the
   per-flush search-reindex cost that floors fluidity.
3. **Reconnect:** on (re)subscribe the client seeds from durable `messages.text` then re-attaches
   to the live plane — no token loss, because durability never depended on the live channel.
4. **Surface in-flight status:** persist (or stream on the live plane) `run.status` and
   `tool.status` so the UI can show working/compacting/tool phases — additive to the schema,
   **optional** fields (push validates rows), per the invariants.
5. **Provider-agnostic:** because both planes consume the **normalized vocabulary** (§2.3),
   OpenClaw and Hermes feed the identical pipeline — the decoupling lives entirely behind the
   abstraction boundary.

**Sources for §4:** in-repo `convex-writer.ts`, `run-manager.ts`, `bridge/src/normalizer.ts`,
`CONVEX_MIGRATION.md` (openclaw-notes, private; current persistence chain), Image-#23 callout (task brief). No
external streaming-library claim is made; the per-token-coalescing correction and the
display=persistence coupling are read directly from code.

---

## 5. `docs/BRIDGE_PROTOCOL.md` — STILL TRUE vs STALE

The doc was written for the **pre-Convex** (Firebase-auth, browser-facing-WS, signed-media-URL)
architecture. Mark before depending on any section.

### STILL TRUE (the provider-abstraction contract)
- **The normalized streaming vocabulary** (`message.delta/.snapshot/.final`, `run.status`,
  `tool.status`, `media`) as the stable seam frontends/providers depend on — matches §2.3.
- **Isolation & sanitization rules** (sessionKey match + own-run refinement; drop foreign /
  sessionless / background runs; strip `/home/node/.openclaw/...`; never forward credentials) —
  matches `normalizer.ts` L360-377 + `sanitize.ts`.
- **`run.status = compacting` ⇒ discard the partial reply and wait for restart** — matches the
  `abandoned` path in the normalizer.
- **OpenClaw version-compatibility strategy** ("all version-specific parsing in the normalizer;
  frontend sees only stable events; add a fixture per new shape") — still the governing rule.
- **`chat.send` precondition:** the bridge sends `sessions.patch verboseLevel:"full"` before
  `chat.send` (doc §`chat.send` / matches `server.ts` L119-138).

### STALE / SUPERSEDED (do **not** implement from these)
- **`media` event shape CHANGED, not merely re-skinned:** doc shows
  `{type:"media", items:[{filename, url:"…/api/media/outbound/…?sig=…"}]}`; the current
  normalizer emits **`{filename, path}`** (bytes → Convex File Storage; the ingest action holds
  media creds). **The entire signed `GET /api/media/outbound/{filename}…` endpoint + "Security
  Model for Media" section is stale** (`normalizer.ts` L582-607; `convex-writer.ts addMedia`).
- **Browser-facing WS + endpoints are stale/not-implemented:** doc describes
  `WS /ws/chats/{chatId}`, `GET /api/capabilities`, `GET /api/me`, browser→bridge messages
  (`auth/ping/chat.history/chat.send/chat.abort`) and bridge→browser messages
  (`bridge.ready/chat.history/...`). The **current** `bridge/src/server.ts` exposes **only**
  `GET /health` and `POST /send`; the browser talks to **Convex**, not the bridge.
- **Auth is different:** doc says `Authorization: Bearer <firebase-id-token>`. Actual:
  `POST /send` uses the **raw `BRIDGE_SHARED_SECRET`** (no `Bearer`, constant-time compared,
  `server.ts` L177-182); the bridge→Convex ingest uses `Bearer <BRIDGE_INGEST_SECRET>`
  (`convex-writer.ts` L140-144). Firebase auth is superseded by Convex Auth (browser↔Convex).
- **`GET /api/capabilities` / protocol-version `0.1` discovery:** not served by the current
  bridge; capability negotiation now lives in the Convex app layer.
- **`openclaw.frame` passthrough:** still emitted by the normalizer but **dropped** by the
  run-manager (not persisted) — deprecated and effectively inert in the Convex path.

### Forward-looking gap (flag, not stale)
- The doc's `tool.status` / intermediate `run.status` are in the vocabulary but **not yet
  persisted** (run-manager drops them). Surfacing in-flight tool/run status in the UI (a task
  goal) requires additive, **optional** schema fields + a persistence/live-plane path (§4.2).

---

## 6. Consolidated NOT FOUND / unverified (must capture against a live gateway before relying on them)

1. **OpenClaw conversation-list / `chat.history` request+response shapes** — not in repo
   (comments only); doc-named, never extracted. **NOT FOUND.**
2. **`artifacts.list/get/download`, sessions-index, `tasks.list`, `cron.*` param/response
   shapes** — doc-named, unused by the bridge, unverified.
3. **Webchat sessionKey segment grammar** (`webchat:chat:<canonical>:<chatId>`) — fixture/code
   only; no public-doc confirmation.
4. **Frame envelope on the webchat path** — bare `{event,payload}` (fixtures) vs doc's
   `{type:"event",…}`; cause of the difference NOT FOUND.
5. **Device pairing/approval flow & exact device-identity provisioning** — in
   `gateway/pairing.md` + `reference/device-models.md` + the bridge secret store; read in full
   before implementing (search-engine prose was confabulated — distrust).
6. **OpenClaw multi-agent / default-agent resolution & "ask which instance per new chat"
   semantics** — `concepts/multi-agent.md` + `gateway/config-agents` located but not fully
   extracted.
7. **Hermes:** runs-events SSE vocabulary, version pin, per-user auth mode (appears absent),
   outbound non-image media, subagent exposure — all **NOT FOUND** / unverified.
8. **Convex streaming primitive** for the §4.2 live plane — `[unverified]`; validate against the
   pinned Convex version.
