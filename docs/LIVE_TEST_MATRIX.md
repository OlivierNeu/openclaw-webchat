# LIVE TEST MATRIX — openclaw-webchat × OpenClaw

**Version oracle:** the hello-ok `server.version` from the gateway connect handshake.
**Baseline live result:** `server.version = "2026.5.19"`, protocol 4 (captured 2026-06-04).
**Authoritative status:** exactly ONE scenario is GREEN-live (**F1**). Everything else is **PLANNED** (offline-replay-passing, verified-in-source, or unbuilt). This document is the re-runnable, version-keyed suite plus the regression gate.

> **Honesty rule (load-bearing).** The `status` column is ruthless: `GREEN-live` means *observed against the real v2026.5.19 gateway*. A passing offline unit test, a TypeBox schema citation, or a design invariant is **PLANNED**, never green. A passing self-test is not evidence of live behavior. Where docs and live frames diverge, the **live frames are ground truth** — cite a `NOT FOUND` rather than inventing an API shape.

Authoritative file on disk: `docs/LIVE_TEST_MATRIX.md`.

---

## 0. Harness mechanism (how every scenario runs)

The full path a stimulus takes (mirrors `send.sendMessage`, but dev-triggered with no browser):

```
dev.testSend  →  messages(user, optimistic)  →  outbox(pending)
              →  scheduler → internal.bridge.dispatch
              →  resolve routing override (overrideInstance) → POST /send (bridge)
              →  gateway WS  →  inbound frames  →  Normalizer  →  TurnSink
              →  ConvexWriter → POST /bridge/ingest (httpAction)
              →  internal.stream.* (startAssistant/appendDelta/setSnapshot/addPart/finalize)
              →  messages / messageParts  →  assistant-ui re-render
```

### 0.1 Pre-wire once (routes the dev test user to a non-null target)

```bash
npx convex run dev:routeUser '{
  "instanceName":"admin",
  "gatewayUrl":"wss://gateway.lacneu.com",
  "agentId":"olivier",
  "canonical":"olivier"
}'
```

`dev.routeUser` upserts the non-secret `instances` row and sets a per-user `overrideInstance/overrideAgentId/canonical` on the matching active profile(s). With no `email` it routes every active `user|admin` profile (foolproof on a single-operator dev box). The **bridge** holds the gateway token + Ed25519 device identity + `OPENCLAW_CANONICAL` in its OWN env (`bridge/src/config.ts`) — Convex stores only the non-secret instance name.

### 0.2 Fire a stimulus (dev-gated; requires `OPENCLAW_ENABLE_ANON_AUTH=1`)

```bash
CONVEX_AGENT_MODE=anonymous npx convex run dev:testSend '{"text":"…","chatId":"<optional>"}'
# returns { ok, chatId, messageId, outboxId }  ← use chatId for follow-ups + polling
```

`dev.testSend` (`convex/dev.ts:356`) inserts the optimistic user `messages` row, the `outbox` row, and schedules `internal.bridge.dispatch`. **Known limitation (G2):** it picks the FIRST profile carrying an `overrideInstance` (`dev.ts:364`) — there is NO user selector argument, so it cannot drive two distinct users. See G2.

### 0.3 Run the bridge with frame capture (the version-fixture oracle)

```bash
cd bridge && npm run build && BRIDGE_DEBUG=1 node --env-file=.env dist/index.js
```

`BRIDGE_DEBUG=1` is the ONLY place message content is logged (dev-only, olivier instance only — see PHI invariant). It captures hello-ok (`server.version` = the version key) and every raw inbound frame → a version-keyed fixture, replayed offline by `bridge/test/normalizer.test.ts` and `bridge/test/multiplex.test.ts`.

### 0.4 The four oracle classes

| Oracle | Mechanism | Used for |
| --- | --- | --- |
| **Convex-poll (deterministic)** | poll `messages` by_chat for `status ∈ {streaming,complete,error,aborted}` + expected `text`; poll `messageParts` by_message for `part.kind ∈ {tool,media,file,reasoning}` + `storageId/mimeType/filename` | the default; every text + parts scenario |
| **Offline-replay (deterministic)** | replay a version-keyed fixture through the Normalizer/Multiplexer; assert emitted events | every normalizer-behavior scenario that is hard to force live |
| **Frame capture (version key)** | `BRIDGE_DEBUG=1` raw frames → fixture; `server.version` is the key | the regression bench; new-version diffs |
| **History reconcile (G7, unbuilt)** | `chat.history({sessionKey})` → diff display-normalized transcript vs Convex `messages` | F-RECON only — **capability does not exist yet** |
| **Browser/human** | render-only assertions (spinner, tool-toggle render) | reserved ONLY for genuinely visual behavior; never where a Convex-poll proves the same invariant |

---

## 1. Fixed layer vocabulary

Every feature names a subset of these layers:

`stimulus(dev.testSend)` · `outbox` · `bridge.dispatch` · `gateway-WS` · `inbound-frames` · `normalizer` · `turn-sink` · `convex-writer` · `bridge_ingest` · `stream-mutations` · `messages` · `messageParts` · `convex-storage` · `frontend-render` · `multiplexer` · `chat.history` · `artifacts.*` · `sessions.compaction.*`

---

## 2. Confidence tiers (annotation, NOT status)

These annotate *how much we know*; they do NOT promote a row to GREEN-live.

- **CONFIRMED-live** — observed against the real v2026.5.19 gateway. ONLY: F1; both inbound frame families (`agent` stream:lifecycle/assistant + `chat` state:delta/final); sessionKey grammar `agent:olivier:webchat:chat:olivier:<convexChatId>`; `lifecycle:end` carrying `livenessState:"working"`; the `chat.send` ack carries NO runId (the runId arrives in frames as `webchat-<hash>`).
- **VERIFIED-in-source** — read in the v2026.5.19 TypeBox schema (tag `dc44220d`; base URL `https://raw.githubusercontent.com/openclaw/openclaw/v2026.5.19/`): `artifacts.list/get/download` shapes + `download.mode ∈ bytes|url|unsupported`; `ArtifactSummary` (`title`/`sizeBytes`, **NO** `filename`); inbound `chat.send.attachments` dual runtime shape (flat `{type,mimeType,fileName,content}` OR `{source:{type:'base64',media_type,data}}`); OOXML zip-sniff override; 20MB `mediaMaxMb` + 2MB offload threshold + `media://inbound/<id>`; typed `sessions.operation{operation:'compact',phase:'start'|'end',reason}` + `sessions.compaction.list/get/branch/restore`; `chat.* error` carries `errorKind ∈ refusal|timeout|rate_limit|context_length|unknown`. **Source citation, not a live observation.**
- **VERIFIED-in-code** — read in THIS repo's source (file:line cited in the row). Behavior of the Normalizer / TurnSink / Multiplexer as implemented. Proven offline, NOT live.
- **UNVERIFIED (HYPOTHESIS)** — must be settled by live capture; never certified against today's fixture. The headline UNVERIFIED item is the **compaction discard signal** (see §6 + F-COMPACT-MANUAL).

---

## 3. Capability gates (build order — what must exist before a scenario runs live)

| Gate | What it is | State | Blocks |
| --- | --- | --- | --- |
| **G0** | Legacy single-chat path proven live (`session.ts`) | **LIVE NOW** | F1–F11, F-ISO-*, F-FILEOUT-STREAM |
| **G1** | Model A adapter + `core/registry.ts` | **PARTIAL** — only `multiplex.ts` SessionMultiplexer built + offline-tested (5 tests); `adapter.ts` + registry NOT built | F-PARALLEL-CONVO, F-MULTIUSER at scale |
| **G2** | `dev.testSend` user selector | **NOT BUILT** — `testSend` picks the first override profile (`dev.ts:364`); needs a `canonical`/`email` arg + two routed profiles | F-MULTIUSER |
| **G3** | Convex→base64 attach wiring (files-in) | **NOT BUILT** — `server.ts performSend` forwards `attachments` opaquely; Convex must read `uploads.storageId` bytes → base64 → flat attachment shape before `dev.testSend` can carry a file | F-FILEIN-* |
| **G4** | `artifacts.download` outbound path | **NOT BUILT** — robust retrieval: `artifacts.list({sessionKey})` → `artifacts.download` → branch bytes/url/unsupported → Convex File Storage → `messageParts.storageId`. Distinct from the streamed `mediaUrls`+`addMedia` path (F-FILEOUT-STREAM, G0) | F-FILEOUT-ARTIFACT, F-IMAGE-OUT, F-AUDIO-OUT |
| **G5** | UI processing markers + tool show/hide pref | **NOT BUILT** (backend signal missing — see §5 fix) — needs a schema-backed intermediate run-state channel + a per-user tool-visibility pref | F-MARKER-PROCESSING, F-TOOL-TOGGLE, F-HEAVYWORK oracle |
| **G6** | `sessions.compaction.*` / typed compact-event handling | **NOT BUILT** — normalizer keys only on `livenessState=="abandoned"` (`normalizer.ts:524`) | F-COMPACT-AUTO |
| **G7** | **chat.history pull + Convex reconcile mutation** (NEW — from red-team) | **NOT BUILT** — `chat.history` is referenced ONLY in two "deferred" comments (`normalizer.ts:338,482`); implemented NOWHERE | F-RECON-ARCHIVED |
| **GA** | A2 live-text field (`liveText`) decoupling stream from search index (NEW — from red-team) | **NOT BUILT** — see §5 fix #1 | the A2 invariant asserted by F-LONGCONVO/F-BIGPASTE/F-HEAVYWORK |

---

## 4. Red-team must-fixes folded into this matrix

These corrections override the original matrix prose. Each becomes a status/oracle/gate change here; **none is a code change in this document** — recommended code fixes are listed for the user's review (never auto-applied, never committed).

### Fix #1 — A2 "un-indexed live field" claim is FALSE against the code
`convex/schema.ts:217` defines `messages.text: v.string()` AND `:228-230` puts `searchIndex("search_text",{searchField:"text"})` on that SAME field. The schema comment itself admits it (`:226-227`: *"`text` is patched in place during streaming, so this index re-indexes on each token patch"*). `appendDelta` patches `{text: message.text + text}` (`stream.ts:132`) and `setSnapshot`/`finalize` also patch `text`. There is **NO** separate un-indexed live field. So every delta flush rewrites the growing text (O(n²) over a long turn) AND re-indexes the search field.
**Matrix decision:** the A2 "un-indexed live field" invariant is **RETRACTED** as a live claim and re-cast as gate **GA**. Until GA lands, F-LONGCONVO/F-BIGPASTE/F-HEAVYWORK make the **per-flush write + reindex cost the PRIMARY oracle** (a measured benchmark), not a "secondary perf trend."
**Recommended code fix (for user review):** add an un-indexed `liveText` field patched during streaming; write the reconciled text into the indexed `text` ONLY in `finalize`.

### Fix #2 — processing markers have no backend channel; intermediate run.status is DROPPED
`bridge/src/core/turn-sink.ts:120-128` explicitly drops `working/running/compacting`: *"Intermediate statuses … have no schema representation -> dropped."* The Normalizer emits `EVENT_RUN_STATUS`, but the sink swallows them — they never reach Convex.
**Matrix decision:** every "run.status working/running observable via Convex-poll" oracle is **REMOVED**. The ONLY Convex-visible processing signal today is `messages.status === "streaming"`. F-HEAVYWORK/F-MARKER-PROCESSING/F-TOOL-TOGGLE are gated behind **G5**.
**Recommended code fix (for user review):** add a schema-backed `messages.runState` enum (or a lightweight live field) and stop dropping it in turn-sink; then poll it.

### Fix #3 — compaction discard keyed on an UNVERIFIED signal
`normalizer.ts:524` resets buffers ONLY on `data.livenessState === "abandoned"`. `abandoned` has **NEVER** been seen live; the `compaction-abandoned-replay` fixture is synthetic and its cited provenance (`openclaw-notes/...`, `HANDOFF-OPENWEBUI-2026-05-17.md`) **does not exist on disk** (verified: no `openclaw-notes` dir). If the real gateway signals compaction via the typed `sessions.operation{operation:'compact'}` instead, the normalizer never resets → pre-/post-compaction deltas CONCATENATE → the webchat transcript diverges from OpenClaw's real compacted context — exactly the user's CRITICAL mismatch risk, produced by production code keyed on an unverified field.
**Matrix decision:** F-COMPACT-MANUAL's deliverable is a **BLOCKING discriminator capture**, not a pass. Do NOT certify "abandoned resets buffers" against today's fixture. Status stays **UNVERIFIED** until a `/compact`-live raw-frame capture names the authoritative discard field.

### Fix #4 — archived-session recovery (chat.history reconcile) is UNIMPLEMENTED
`chat.history` appears only in two "deferred" comments (`normalizer.ts:338,482`); there is no reconcile mechanism anywhere in `bridge/src` or `convex/`.
**Matrix decision:** F-RECON is gated behind **G7** (new). Not runnable until a `chat.history` pull + a Convex reconcile mutation lands. **Reconciliation direction:** on archive, **OpenClaw is the source of truth**; the reconcile repairs/replaces the chat's Convex `messages` to match OpenClaw's transcript. Conflict policy must be specified when G7 is built.

### Fix #5 — F-MULTIUSER is unbuildable on the single-identity bridge
`bridge/src/config.ts` loads exactly ONE `openclawToken`, ONE `deviceIdentity`, ONE `canonical` from env (`:139-143`). There is NO `instanceName→token` map. The "bridge maps instanceName → token from its own env" claim is FALSE for multi-identity.
**Matrix decision:** F-MULTIUSER is **UNBUILDABLE today**; it requires G1 (adapter/registry, partial) + G2 (testSend selector, unbuilt). Marked PLANNED-blocked.

> Note: the orchestrator's challenge array was truncated mid-issue-#5; only the five issues above were present in the source and all are folded in. Any later issues were not reconstructable from the given input.

---

## 5. Scenario matrix

Status legend: **GREEN-live** (observed v2026.5.19) · **PLANNED** (offline-replay or source-verified, not live) · **PLANNED-blocked** (needs a capability gate) · **UNVERIFIED** (must be settled by live capture). `PLANNED-blocked` and `UNVERIFIED` are subtypes of `PLANNED`; only **F1** is `GREEN-live`.

### 5.A — Core text round-trip & normalizer behavior (gate G0)

| id | title | layers | stimulus | expected | oracle | dependsOn | status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **F1** | Text send → stream → final → persist (ROOT) | stimulus·outbox·bridge.dispatch·gateway-WS·inbound-frames·normalizer·turn-sink·convex-writer·bridge_ingest·stream-mutations·messages·frontend-render | `dev.routeUser` once, then `dev.testSend '{"text":"Bridge validé, je te reçois bien."}'`. Single short prompt, spaced. | **[CONFIRMED-live]** streaming assistant row created (`startAssistant`), text accumulates via deltas/snapshot, finalizes `status:"complete"` with the reply. sessionKey accepted; ack carries no runId (frames carry `webchat-<hash>`). | Convex-poll: `messages` by_chat reaches `status:"complete"` non-empty within recv budget. Secondary: `BRIDGE_DEBUG` capture = the v2026.5.19 baseline fixture. | — | **GREEN-live** |
| **F2** | 5.19 message snapshot REPLACES (content list) | inbound-frames·normalizer·convex-writer·stream-mutations·messages | Prompt eliciting a full-message snapshot (`chat state:delta` then `state:final` with `message.content=[{type:text,text}]`). Replay `chat-final-content`; opportunistic live capture. | **[CONFIRMED-live family / VERIFIED-in-code]** `setSnapshot` REPLACES (not appends): final text = last snapshot; later deltas after a snapshot ignored (`hasSnapshot` lock). | Convex-poll: final `text` == snapshot, not the running concat. Offline-replay `chat-final-content`. | F1 | **PLANNED** |
| **F3** | Legacy 5.7 agent assistant deltas accumulate | inbound-frames·normalizer·convex-writer·stream-mutations·messages | `agent stream:assistant data.delta` chunks closed by `lifecycle:end`. Offline-replay `agent-assistant-delta-legacy`; live only if the agent path emits legacy deltas. | **[VERIFIED-in-code]** deltas append verbatim (`'Hello '`+`'world'`) closed by `lifecycle:end (working)`. | Convex-poll final == concat; offline-replay fixture. Tag: offline-replay-deterministic (hard to force the legacy path on 5.19). | F1 | **PLANNED** |
| **F4** | deltaText spaces preserved verbatim | inbound-frames·normalizer·stream-mutations·messages | `chat state:delta deltaText` with leading/trailing spaces, then `state:final`. Offline-replay `chat-deltatext-spaces`. | **[VERIFIED-in-code]** leading/trailing spaces are load-bearing and preserved; no trimming. | Convex-poll exact-string equality (spaces matter); offline-replay. | F1 | **PLANNED** |
| **F5** | Empty final → grace wait → real content wins | inbound-frames·normalizer·stream-mutations·messages | An empty `chat:final` arrives before real content. Offline-replay `chat-final-empty-then-content`; live when a foreign health broadcast lands mid-turn. | **[VERIFIED-in-code]** empty final is NOT turn-end: `EMPTY_FINAL_GRACE` (90s) arms; foreign health frames dropped; real text arrives after and finalizes. Never persists blank. | Convex-poll: final text is real content, `status:"complete"` (never an empty complete). Offline-replay. | F1 | **PLANNED** |
| **F6** | Duplicate final / exact re-broadcast deduped | inbound-frames·normalizer·stream-mutations·messages | Exact re-broadcast (same runId/seq/state/deltaText/content); also two identical empty finals. Offline-replay `duplicate-final` + `duplicate-empty-final`. | **[VERIFIED-in-code]** identical re-broadcast deduped (content-fingerprint key); distinct seq passes. Two identical empty finals collapse + finalize after grace, never double-arm/hang. | Convex-poll: no duplicated segment; exactly one finalize. Offline-replay-only (hard to force a real duplicate live). | F1, F5 | **PLANNED** |
| **F7** | Private-ack suppressed, visible message wins | inbound-frames·normalizer·stream-mutations·messages | A short ack (`'Envoyé.'`) final, then the real visible message (different content). Offline-replay `private-ack-then-visible`. | **[VERIFIED-in-code]** the private-ack (`PRIVATE_ACK_RE`) never persisted; `PRIVATE_ACK_GRACE` (5s) holds it; the visible message (different fingerprint) replaces it and finalizes. | Convex-poll: final text is the visible message, NOT `'Envoyé.'`. Offline-replay-only (forcing a real ack-then-visible live is nondeterministic). | F1 | **PLANNED** |
| **F8** | Private-ack-only → graceful best-effort finalize (never hang) | inbound-frames·normalizer·stream-mutations·messages | Only a private ack arrives, nothing follows. Offline-replay `private-ack-only`. | **[VERIFIED-in-code]** after `PRIVATE_ACK_GRACE` with no follow-on, `tick()` finalizes best-effort (text = the ack) → complete. Never hangs. | Convex-poll under a mocked/elapsed clock offline: a finalize occurs within grace. Offline-replay-only. | F7 | **PLANNED** |
| **F9** | Follow-on run admitted during lifecycle-end grace | inbound-frames·normalizer·stream-mutations·messages | Empty final + `lifecycle:end (working)` on run-own, then a NEW runId (run-follow) with real text during `LIFECYCLE_END_GRACE` (10s). Offline-replay `lifecycle-end-then-followon-run`. | **[VERIFIED-in-code]** follow-on run admitted into `ownRunIds` while the lifecycle-end grace is open; its text becomes the answer. A follow-on AFTER the grace is dropped as background. | Convex-poll: final text == follow-on. Offline-replay; live-provokable when the agent chains runs. | F1, F5 | **PLANNED** |
| **F10** | Lifecycle error finalizes turn as error | inbound-frames·normalizer·stream-mutations·messages | Provoke a context-overflow/provider error (deliberately oversized prompt) → `lifecycle phase:error`. Offline-replay `lifecycle-error`. | **[VERIFIED-in-code]** `phase:error` finalizes `status:"error"` with a concise `extractLifecycleError`. NOTE: `chat.* error` ALSO carries `errorKind ∈ refusal|timeout|rate_limit|context_length|unknown` **[VERIFIED-in-source]** — capture which path the live gateway uses. | Convex-poll: `messages.status=="error"`, `messages.error` set, no false complete. Offline-replay. Live-provokable via oversized prompt (space it). | F1 | **PLANNED** |
| **F11** | message-tool: current-chat reply vs external target | inbound-frames·normalizer·stream-mutations·messages·messageParts | Agent uses the `message` tool (action send) into the current chat; separately into an external target (`telegram:123`). Offline-replay `tool-message-visible` + `tool-message-external-target-ignored`. | **[VERIFIED-in-code]** a `message`-tool send to a CURRENT_CHAT channel is the visible reply and locks out a later private-ack `chat:final`; a send with an explicit external target is IGNORED (no cross-channel leak). | Convex-poll: visible-tool → final is the tool message; external-target → final is the real chat reply, NOT the external message. Offline-replay. | F1 | **PLANNED** |

### 5.B — Isolation (PHI-leak invariant — HIGHEST PRIORITY)

These prove the per-user boundary. A miss here is a PHI leak. Isolation is **double-layered**: the SessionMultiplexer routes by `payload.sessionKey` and DROPS frames for unregistered sessions (`multiplex.ts:83-95`, outer layer); the Normalizer re-checks its OWN sessionKey (inner layer). Convex read-scoping in `messages.ts` is the final layer (a user can never read another's streamed row).

| id | title | layers | stimulus | expected | oracle | dependsOn | status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **F-ISO-SESSION** | Foreign-session frame DROPPED | inbound-frames·multiplexer·normalizer·stream-mutations·messages | Inject (offline + live capture) a frame whose `payload.sessionKey` ≠ the active session. Offline-replay `isolation-foreign-session`. Live: the one operator WS sees ALL gateway sessions (gateway gates by `operator.read` SCOPE, not user) so foreign sessions WILL appear. | **[CONFIRMED design invariant / VERIFIED-in-code]** `feedFrame` returns `[]` for an unregistered sessionKey (`multiplex.ts:88-91`); no `messages`/`messageParts` row is written for the foreign chat. | Convex-poll: ZERO rows written under any chat but the active one. Offline-replay `multiplex.test.ts` foreign-session case. Live: capture all sessions, assert only the active chat receives writes. | F1 | **PLANNED** (highest priority) |
| **F-ISO-RUN** | Foreign-run frame within the OWN session dropped | inbound-frames·normalizer·stream-mutations·messages | A frame carrying a runId NOT in `ownRunIds` arrives on the active session (background run on the same agent). Offline-replay `isolation-foreign-run`. | **[VERIFIED-in-code]** a runId outside `ownRunIds` (seeded from the `chat.send` ack + admitted follow-ons, `multiplex.ts:71-73`) is treated as background and does NOT become this turn's answer. | Convex-poll: the active turn's final text is the OWN run's, never the background run's. Offline-replay. | F1, F9 | **PLANNED** |
| **F-ISO-SESSIONLESS** | Sessionless / health broadcast frame dropped | inbound-frames·multiplexer·normalizer | A frame with no `payload.sessionKey` (e.g. a global `health`/`tick` broadcast). Offline-replay `isolation-sessionless`. | **[VERIFIED-in-code]** `frameSessionKey` returns null → `feedFrame` returns `[]` (`multiplex.ts:84-87`); the Normalizer's foreign-health drop is the inner guard. | Convex-poll: no write attributed to any chat from a sessionless frame. Offline-replay. | F1 | **PLANNED** |

### 5.C — Files OUT (OpenClaw → user)

| id | title | layers | stimulus | expected | oracle | dependsOn | status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **F-FILEOUT-STREAM** | Streamed media path (`mediaUrls`+`addMedia`) | inbound-frames·normalizer·turn-sink·convex-writer·convex-storage·stream-mutations·messageParts·frontend-render | Prompt the agent to produce a file it surfaces via streamed `media`/`mediaUrls`. The writer reads bytes from `mediaOutboundDir` → `ctx.storage.store` → `addPart{kind:media}`. (G0 path.) | **[VERIFIED-in-code]** `addMedia` per item; `messageParts` gets a `kind:"media"` with `storageId`/`filename`/`mimeType`. | Convex-poll `messageParts` by_message for `kind:"media"` + non-null `storageId`; fetch the storage URL renders. Frame capture of the media frame family. | F1 | **PLANNED** |
| **F-FILEOUT-ARTIFACT** | Robust retrieval via `artifacts.download` | gateway-WS·artifacts.*·convex-storage·messageParts·frontend-render | `artifacts.list({sessionKey})` → `artifacts.download` → branch `bytes`/`url`/`unsupported` → Convex File Storage → `messageParts.storageId`. | **[VERIFIED-in-source]** `ArtifactSummary` has `title`/`sizeBytes`, **NO** `filename`; `download.mode` decides the branch. Render falls back gracefully on `unsupported`. | Convex-poll `messageParts` `kind:"file"` + `storageId`/`mimeType`. Frame capture of `artifacts.*`. | F-FILEOUT-STREAM, **G4** | **PLANNED-blocked (G4)** |
| **F-IMAGE-OUT** | Image generated by OpenClaw rendered inline | artifacts.*·convex-storage·messageParts·frontend-render | Prompt an image creation; retrieve via G4 (or streamed media if the agent uses it). | image `messageParts` (`kind:"media"`/`file`, `mimeType: image/*`) renders inline. | Convex-poll `mimeType` starts `image/`; storage URL renders. | F-FILEOUT-ARTIFACT | **PLANNED-blocked (G4)** |
| **F-AUDIO-OUT** | TTS / audio artifact retrieved | artifacts.*·convex-storage·messageParts | Use a `tts.*` method (in `features.methods`) → audio artifact → G4 retrieval. | audio `messageParts` with audio `mimeType`. | Convex-poll audio `mimeType` + `storageId`. | F-FILEOUT-ARTIFACT | **PLANNED-blocked (G4)** |

### 5.D — Files IN (user → OpenClaw)

| id | title | layers | stimulus | expected | oracle | dependsOn | status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **F-FILEIN-IMAGE** | User sends an image | convex-storage·outbox·bridge.dispatch·gateway-WS | Upload an image (Convex storage), reference its `storageId` on the outbox; Convex reads bytes → base64 → flat attachment shape; `dev.testSend` carries it. | **[VERIFIED-in-source]** `chat.send.attachments` dual runtime shape (flat `{type,mimeType,fileName,content}` OR `{source:{type:'base64',media_type,data}}`); 20MB `mediaMaxMb`, 2MB offload threshold → `media://inbound/<id>`. | Convex-poll: the agent's reply references the image content; frame capture of the outbound `chat.send` with attachment. | F1, **G3** | **PLANNED-blocked (G3)** |
| **F-FILEIN-DOC** | User sends a doc (pdf/docx/xlsx/pptx/md) | convex-storage·outbox·bridge.dispatch·gateway-WS | Upload an OOXML/pdf/markdown file; same G3 path. | **[VERIFIED-in-source]** OOXML zip-sniff override classifies docx/xlsx/pptx correctly; bytes ≤ thresholds inline, else offloaded. | Convex-poll: reply references the doc content; frame capture confirms attachment mimeType/shape. | F-FILEIN-IMAGE, **G3** | **PLANNED-blocked (G3)** |

### 5.E — Routing at scale (parallel conversations & users)

| id | title | layers | stimulus | expected | oracle | dependsOn | status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **F-PARALLEL-CONVO** | One user, many conversations, no cross-talk | multiplexer·normalizer·stream-mutations·messages | Same user fires sends on chat A and chat B near-simultaneously (distinct `chatId` → distinct sessionKeys). | each reply lands in its OWN chat; the SessionMultiplexer routes each frame by `payload.sessionKey` to the right normalizer (`multiplex.ts`). | Convex-poll: chat A final == reply A, chat B final == reply B; no segment of A in B. Offline-replay `multiplex.test.ts` two-session case. | F1, F-ISO-SESSION, **G1** | **PLANNED-blocked (G1)** |
| **F-MULTIUSER** | Two users prompt in parallel, perfect routing | multiplexer·normalizer·stream-mutations·messages | Two distinct users each fire several sends. **UNBUILDABLE today:** single-identity `config.ts` (`:139-143`) + `testSend` picks the first override profile (`dev.ts:364`). | each user sees only their own replies; per-user isolation enforced by the bridge (sessionKey→chatId→owner + Convex ownership). | Convex-poll per-user: each chat receives only its owner's replies. | F-PARALLEL-CONVO, **G1**, **G2** | **PLANNED-blocked (G1+G2)** |

### 5.F — Load & heavy work

| id | title | layers | stimulus | expected | oracle | dependsOn | status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **F-LONGCONVO** | Very long conversation | stream-mutations·messages·messageParts | Drive a long multi-turn chat (history grows large). | system stays responsive; no recompute amplifier blowup. **A2 "un-indexed live field" invariant is RETRACTED** (Fix #1) — `text` IS the search-indexed field. | **PRIMARY oracle = benchmark** of per-flush write + search-reindex cost (Fix #1), NOT a "secondary perf trend." Convex-poll for correctness; measure `appendDelta` flush cost over a long turn. | F1, (GA for the invariant) | **PLANNED** (invariant blocked on GA) |
| **F-BIGPASTE** | Big text pasted into one message | stream-mutations·messages | Paste a very large block into a single prompt. | message stored + searchable; no per-flush O(n²) blowup on a single huge final. | PRIMARY oracle = write/reindex cost on the large final (Fix #1). Convex-poll correctness. | F-LONGCONVO | **PLANNED** |
| **F-HEAVYWORK** | Heavy OpenClaw work, long processing | normalizer·turn-sink·messages | Prompt heavy work that keeps the agent busy a long time. | the user always sees processing-in-progress; the turn never hangs. **NOTE (Fix #2):** intermediate `run.status` is DROPPED by `turn-sink.ts:120-128`; the ONLY Convex-visible processing signal today is `messages.status==="streaming"`. | Convex-poll: `messages.status==="streaming"` persists during work, then finalizes. **No "run.status working/running observable" oracle** (removed, Fix #2). | F1, **G5** for a richer marker | **PLANNED** (rich marker blocked on G5) |

### 5.G — Compaction & archived-session recovery (req #4, #5 — CRITICAL)

| id | title | layers | stimulus | expected | oracle | dependsOn | status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **F-COMPACT-MANUAL** | Discriminator capture (BLOCKING) | inbound-frames·normalizer·sessions.compaction.* | Run `/compact` LIVE on the olivier instance; capture raw frames (`BRIDGE_DEBUG=1`). | **[UNVERIFIED — HYPOTHESIS]** the deliverable is *the authoritative discard-field decision*, NOT a pass. Current code resets ONLY on `livenessState=="abandoned"` (`normalizer.ts:524`), NEVER seen live; the better candidate is the typed `sessions.operation{operation:'compact',phase}` **[VERIFIED-in-source]**. | **Frame capture** of the real compaction event → name the discard field. Do NOT certify "abandoned resets buffers" against today's synthetic fixture. After capture, re-key the normalizer + pin a version-keyed fixture from REAL frames. | F1 | **UNVERIFIED (BLOCKING)** |
| **F-COMPACT-AUTO** | Auto-compaction mid-conversation | inbound-frames·normalizer·stream-mutations·messages | Drive enough context to trigger auto-compaction; observe replay. | post-compaction the normalizer discards partial pre-compaction deltas and waits for replay; webchat transcript stays consistent with OpenClaw's compacted context. | Convex-poll: no concatenation of pre+post-compaction text; only the replayed content persists. | F-COMPACT-MANUAL, **G6** | **PLANNED-blocked (G6, gated on F-COMPACT-MANUAL)** |
| **F-RECON-ARCHIVED** | Recover a session OpenClaw archived | gateway-WS·chat.history·stream-mutations·messages | OpenClaw archives a session; pull `chat.history({sessionKey})`; reconcile into Convex. **CAPABILITY DOES NOT EXIST** (`chat.history` only in deferred comments `normalizer.ts:338,482`). | **OpenClaw is the source of truth on archive**: the reconcile repairs/replaces the chat's Convex `messages` to match OpenClaw's transcript. Conflict policy specified when G7 is built. | History-reconcile oracle: diff `chat.history` display-normalized transcript vs Convex `messages`; assert equality after reconcile. | **G7** | **PLANNED-blocked (G7)** |

### 5.H — UI markers & tool visibility (req #6, #7)

| id | title | layers | stimulus | expected | oracle | dependsOn | status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **F-MARKER-PROCESSING** | "prompt received / processing in progress" markers | frontend-render·messages | Send a prompt; observe the UI during processing. | UI shows "prompt taken over" + "processing in progress"; never a hung/stuck UI. **NOTE (Fix #2):** needs a backend signal richer than `status:"streaming"` to distinguish phases. | Convex-poll `messages.status` for the streaming→complete transition (the only signal today). Richer markers → browser oracle once G5 lands. | F1, **G5** | **PLANNED-blocked (G5)** |
| **F-TOOL-TOGGLE** | Show/hide tool execution as a per-user chat pref | frontend-render·messageParts·profiles | Toggle tool visibility from the chat; observe rendered tool parts. | tools render when shown; hidden = tool parts suppressed BUT processing-in-progress still visible. Needs a per-user pref + the G5 backend signal. | Browser oracle: tool parts render/hide on toggle; processing marker stays visible when hidden. Convex-poll `messageParts kind:"tool"` exist regardless of the render pref. | F11, **G5** | **PLANNED-blocked (G5)** |

---

## 6. The UNVERIFIED spine — compaction discard signal

The single highest-risk hypothesis. The normalizer resets compaction buffers ONLY on `livenessState === "abandoned"` (`normalizer.ts:524`), a value NEVER observed live; the synthetic fixture's provenance does not exist on disk. If the real gateway uses the typed `sessions.operation{operation:'compact'}` event instead, the buffers never reset and the transcript diverges from OpenClaw — the user's CRITICAL req-#5 mismatch. **F-COMPACT-MANUAL is therefore BLOCKING:** no compaction scenario may be certified until a live `/compact` frame capture names the authoritative discard field. Until then, every compaction row is `UNVERIFIED`, never `GREEN`.

---

## 7. Run against a NEW OpenClaw version (the regression bench)

On every new OpenClaw version:

1. **Read the oracle.** Connect; read hello-ok `server.version`. That is the version key for this whole run.
2. **Target ONLY the olivier dev instance.** NEVER jerome (the protected `family` gateway). Live tests hit ONLY olivier.
3. **Re-run the ENTIRE matrix** against olivier, in dependency order (§5.A → §5.B → … → §5.H), respecting capability gates (skip PLANNED-blocked rows whose gate is unbuilt; note them).
4. **On any divergence:** capture a `BRIDGE_DEBUG=1` fixture keyed by the new `server.version`; extend the Normalizer/Multiplexer; re-run until green AND **all prior version fixtures stay green** (the regression gate — a new-version fix must never break an old-version fixture).
5. **Re-fetch the typed schema** files by tag (`artifacts.ts`, `logs-chat.ts`, `agent.ts`, `sessions.ts`) and diff against the prior tag; fold shape changes into the relevant VERIFIED-in-source rows.
6. **SPACE the sends.** Don't hammer the real agent — single prompts with deliberate gaps.

### 7.1 Regression gate (hard rule)
A change made to pass version N+1 must keep EVERY version-keyed fixture from versions ≤ N green. Fixtures are append-only and version-keyed; the offline-replay suite (`bridge/test/normalizer.test.ts`, `bridge/test/multiplex.test.ts`) is the bench. Green on the new version is necessary but NOT sufficient — the full historical fixture set must stay green.

---

## 8. Human-review-of-code-changes rule (NON-NEGOTIABLE)

- **Code changes SURFACE for the user's review.** When a divergence requires a normalizer/schema/bridge change, the change is proposed and shown — **NEVER auto-applied, NEVER auto-committed, NEVER pushed.** The user owns all commits and pushes.
- Each red-team "recommended code fix" in §4 (GA `liveText`, `messages.runState`, G7 reconcile, compaction re-keying, multi-identity bridge) is a PROPOSAL pending the user's approval — listed here, not applied here.

---

## 9. Invariants (NEVER break)

- **Per-user isolation enforced by the bridge** (sessionKey → chatId → owner + Convex ownership). A routing bug = a PHI leak. Isolation is double-layered (`multiplex.ts` outer route-drop + the Normalizer's inner sessionKey gate) and Convex read-scoping (`messages.ts`) is the final layer. **F-ISO-* is the highest-priority scenario class.**
- **Secrets only in the bridge env / secret store** — never in a Convex table, never in the browser (`config.ts`, `schema.ts` design invariants).
- **PHI: never log message content in traces.** The `traceEvents`/`assistant.stream` traces are metadata-only (lengths, never text). `BRIDGE_DEBUG` dev logs are the ONLY exception — dev-only, olivier instance only.
- **Schema additions to existing tables are OPTIONAL fields** (additive on existing rows); new tables may carry required fields.
- **Live tests hit ONLY the olivier dev instance** — NEVER jerome.
- **Space sends** — don't hammer the real agent.
- **Never git commit / push** — code changes surface for review.

---

### Provenance of the red-team corrections (verified against this repo)

| Claim | Verified at |
| --- | --- |
| `text` is both streamed and search-indexed (no un-indexed live field) | `convex/schema.ts:217, 228-230` (comment `:226-227`); `convex/stream.ts:132` |
| intermediate `run.status` dropped, no schema fit | `bridge/src/core/turn-sink.ts:120-128` |
| compaction resets ONLY on `livenessState=="abandoned"` (never seen live) | `bridge/src/providers/openclaw/normalizer.ts:524` |
| `chat.history` deferred / unimplemented | `normalizer.ts:338, 482`; absent in `bridge/src` + `convex/` |
| `openclaw-notes` provenance dir does NOT exist | filesystem check (no dir) |
| bridge is single-identity (one token/device/canonical) | `bridge/src/config.ts:139-143` |
| `dev.testSend` picks the first override profile (no user selector) | `convex/dev.ts:364` |
| isolation route-drop for unregistered sessionKey | `bridge/src/providers/openclaw/multiplex.ts:83-95` |
