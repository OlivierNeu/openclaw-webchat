# LIVE HARNESS DESIGN — re-runnable, version-keyed feature matrix

Status: DESIGN (not yet built). Anchors the implementation of the re-runnable
live test suite that re-verifies every cross-layer feature against the **real**
OpenClaw gateway on each new version. Does NOT duplicate the feature spec or the
protocol research — it consumes them.

Companion docs (anchors, do not duplicate):
- `docs/BRIDGE_ARCHITECTURE.md` — provider seam, Model A multiplex, A2 streaming, secret store.
- `docs/BRIDGE_IMPLEMENTATION_PLAN.md` — P0/P1/P2 decisions; SessionMultiplexer status.
- `docs/OPENCLAW_CONNECTION_MODEL.md` — Model A; bridge = trusted demux; per-user isolation.
- `docs/OPENCLAW_RESEARCH.md` — v2026.5.19 RPC + frame shapes (artifacts/attachments/compaction).
- `docs/PROJECT_STATE.md` — current live ground truth (server.version, frame families, T4 resolved).

PRIMARY-SOURCE RULE (inherited): the harness asserts on captured frames + Convex
state (ground truth). Where the version-tagged docs are silent, the captured
fixtures win and the divergence is recorded — never invented.

---

## 0. What already exists (reuse, do not rebuild)

The harness is a thin orchestrator over primitives that are ALREADY in the repo
and already proved F1 green live (2026-06-04). It adds NO new transport.

| Primitive | Location | Role in the harness |
| --- | --- | --- |
| `dev.testSend({text, chatId?})` | `convex/dev.ts:356` | THE stimulus trigger. Mirrors `send.sendMessage` (optimistic user msg → `outbox` → `internal.bridge.dispatch`). Returns `{ ok, chatId, messageId, outboxId }`. Dev-gated (`OPENCLAW_ENABLE_ANON_AUTH=1`). |
| `dev.routeUser({instanceName, gatewayUrl, agentId, canonical, email?})` | `convex/dev.ts:284` | One-time wiring per run: sets the profile override so `bridge.dispatch` resolves a non-null target (→ `olivier` instance). Idempotent upsert. |
| `dev.reset()` | `convex/dev.ts:414` | Wipe app tables between runs for a clean oracle (NOT auth tables). |
| `dev.searchProbe({term})` | `convex/dev.ts:244` | Confirms the persisted text reached the search index (an extra oracle for "did it land in `messages.text`"). |
| `bridge.dispatch` → `POST /send` | `convex/bridge.ts`, `bridge/src/server.ts:116` | The dispatch path the trigger fans into. Body `{chatId, openclawChatId, text, clientMessageId, attachments}`. |
| Version oracle | `bridge/src/providers/openclaw/openclaw-client.ts:253-265` | hello-ok `frame.payload.server.version` (= `"2026.5.19"`), logged under `BRIDGE_DEBUG=1` as `connect hello-ok`. |
| Raw frame capture | `openclaw-client.ts:325` `dbg("frame <-", clip(frame))` | Every inbound non-ack frame → stdout when `BRIDGE_DEBUG=1`. Reqs log method+sessionKey ONLY (no PHI); inbound frames are raw (dev-only, olivier instance). |
| Isolation boundary | `bridge/src/providers/openclaw/multiplex.ts` | Routes each frame by `payload.sessionKey` to exactly one Normalizer. THE per-user isolation layer the parallel/multi-user scenarios stress. |
| sessionKey grammar | `bridge/src/providers/openclaw/session-keys.ts` | `agent:<agentId>:webchat:chat:<canonical>:<chatId>` — CONFIRMED accepted live (T4 resolved). |
| Normalized event vocabulary | `bridge/src/core/events.ts` | `message.delta` / `message.snapshot` / `message.final` / `run.status` / `tool.status` / `media`. The harness asserts on the Convex projection of these, not the events directly. |
| Convex oracle target | `convex/schema.ts` `messages` (`status: streaming|complete|error|aborted`, `runId`, `text`) + `messageParts` (`part.kind` media/file, `storageId`/`filename`/`mimeType`) | Polling these IS the pass/fail oracle. |

The ONLY NEW code the harness needs: the `bridge/live/` runner + registry +
fixture machinery below. No production-path change.

---

## 1. Directory layout — `bridge/live/`

Lives under `bridge/` (it imports the bridge's own TS types and the normalizer
fixtures), separate from `bridge/test/` (offline unit tests). Runs with `tsx`/
`node --import tsx` — NOT vitest — because it drives real I/O against a live
gateway and Convex, spaced out, with long timeouts.

```
bridge/live/
  README.md                  # how to run; safety rails (olivier-only); env needed
  runner.ts                  # the orchestrator (CLI entry): npm run live  [-- --feature F1 --version 2026.5.19]
  config.ts                  # loads LIVE_* env; asserts instance === olivier (hard refusal otherwise)
  oracle/
    convex-poll.ts           # poll Convex for the expected final state (uses runOneoffQuery / dev queries)
    assertions.ts            # reusable matchers (finalStatus, hasMessagePart, deltaMonotonic, noCrossTalk…)
  capture/
    frame-tap.ts             # subscribe to the bridge's BRIDGE_DEBUG frame stream (see §6), parse `[oc] frame <-`
    fixture-writer.ts        # write version-keyed raw-frame fixtures + a per-run diagnosis.json
  registry/
    features.ts              # THE feature registry — one entry per matrix row (consumes the spec, §2)
    types.ts                 # Feature, Stimulus, Oracle, Scenario, RunResult, MatrixCell
  scenarios/
    chat.ts                  # F1 text round-trip, F3 long/big-paste, F6 wait markers, F7 tool toggle
    files.ts                 # F2 inbound (both attachment shapes) + outbound (artifacts.download)
    compaction.ts            # F4 provoke compaction; F5 archived-session history reconciliation
    routing.ts               # F8 parallel-conversation routing (one user) + F9 multi-user parallel
  fixtures/
    2026.5.19/               # version-keyed dir (the version = hello-ok server.version)
      F1-text-roundtrip/
        frames.jsonl         # raw inbound frames captured this run (one JSON frame per line)
        diagnosis.json       # parsed: families seen, runIds, sessionKeys, timings, divergences
        oracle.json          # the Convex final state snapshot the assertions ran against
      F2-file-outbound-pdf/
        …
    _schema.md               # what a fixture dir MUST contain; how regression diffs read it
  reports/
    matrix-2026.5.19-<runId>.json   # machine-readable per-feature×version result
    matrix-latest.md                # human-readable matrix (regenerated each run)
```

Rationale for `bridge/live/` (not `convex/` or repo root): the runner needs the
bridge's `GatewayFrame` type, the normalizer event names, and the fixture format
the bridge already emits; co-locating keeps the version oracle + frame parser
next to the code that produces them.

---

## 2. The feature registry (consumes the matrix)

`registry/features.ts` is the single source the runner iterates. Each entry is a
declarative `Feature` so the matrix, the report, and the regression gate all
derive from ONE list. The spec's 10 feature areas map to registry rows:

```ts
interface Feature {
  id: string;                 // "F1" … "F9" (+ sub-ids "F2-in-flat", "F2-out-pdf")
  title: string;
  spec: string;               // one-line cite to the user's feature universe item #
  stimulus: Stimulus;         // how the run is driven (§3)
  oracle: Oracle;             // the expected final Convex state + frame-family expectation (§4)
  pacing: { preDelayMs: number; timeoutMs: number };  // spacing + oracle deadline (§3)
  isolation?: IsolationCheck; // for F8/F9: the no-cross-talk assertion (§7)
  requiresMethods?: string[]; // hello-ok features.methods gate (skip+report if absent on this version)
}
```

Registry rows (one per matrix row; sub-rows expand the file/format axes):

| id | Spec item | Stimulus | Oracle (Convex final state) | Frame-family expectation |
| --- | --- | --- | --- | --- |
| F1 | #1 chat e2e | `testSend(text)` | one `messages` row role=assistant **status=complete**, non-empty `text`; user row complete | `chat` (delta→final) AND/OR `agent` (assistant/lifecycle) |
| F2-in-flat | #2 inbound flat attachment | `testSend` + `attachments:[{type,mimeType,fileName,content:<b64>}]` | assistant accepted; no `unsupported` error row | ack ok; inbound-normalize accepted |
| F2-in-source | #2 inbound Anthropic shape | `attachments:[{source:{type:'base64',media_type,data}}]` | same | same |
| F2-in-docx | #2 OOXML not zip-sniffed | send a .docx (mime `…wordprocessingml`) | assistant references the file as the Office type, NOT zip | ack ok |
| F2-out-pdf/docx/pptx/xlsx/md/img/audio | #2 outbound artifacts | prompt that makes the agent create+convert a file | `messageParts` row `kind` in {media,file} with `storageId`+`mimeType` | `media` event today; `artifacts.list`→`download` once built (§2.2) |
| F3 | #3 long/big-paste/heavy | `testSend` with a very long `text` (e.g. 50–200 KB) | final `text` complete; reconciled into the searchable `messages.text` (no O(n²) amplification — A2) | many `delta`/`snapshot`; one `final` |
| F4 | #4 provoke compaction | drive a long conversation past the context threshold on the SAME chatId until compaction fires | partial run discarded; final assistant row reflects the REPLAYED run, not the abandoned partial | typed `sessions` compact op (`operation:'compact'`, phase) AND/OR lifecycle `livenessState` (capture which is authoritative — see §8) |
| F5 | #5 archived-session recovery | after compaction/archival, reconcile via `chat.history` | webchat `messages` match OpenClaw's real context (no phantom/missing turns) | `chat.history` pull |
| F6 | #6 wait markers | `testSend`; observe during processing | `messages` row enters **status=streaming** within deadline (the "prompt taken over" + "still processing" marker); never hangs in streaming past timeout | first delta/lifecycle:start |
| F7 | #7 tool display toggle | a prompt that makes the agent run a tool; toggle the chat preference | with show: `tool.status` projected to a visible part; with hide: tools hidden BUT streaming/processing still visible | `tool` stream / `tool.status` |
| F8 | #8 parallel routing (one user) | `testSend` on **chatId A** and **chatId B** interleaved | each chat has exactly one assistant final whose frames carried THAT chat's own `sessionKey`; zero cross-talk | two sessionKeys, no leakage |
| F9 | #9 multi-user parallel | two routed profiles (needs `testSend` actor selector — §2.1), several sends each in parallel | every reply owned by the correct `userId` + in the correct chat, keyed by `sessionKey` | per-sessionKey isolation under load |

`requiresMethods` lets a feature self-skip on a version whose hello-ok
`features.methods` lacks the RPC (e.g. `artifacts.download`), recording
`skipped(method-absent)` instead of a false fail.

### 2.1 REQUIRED: a `testSend` actor selector (F9 blocker)

`dev.testSend` as written (`convex/dev.ts:356`) is **not multi-user capable**:
it resolves the actor as `profiles.find(p => p.overrideInstance)` — the FIRST
overridden profile, with no selector — and its chatId guard rejects any
`chat.userId !== userId`. With two routed profiles (F9), every send fires as the
same first user and cannot target U2's chat. So F9 is **undrivable** until
`testSend` (or a sibling `dev.testSendAs`) gains an optional actor selector
(`email` / `canonical` / `asUserId`) that picks WHICH routed profile owns the
turn, mirroring how `routeUser` already accepts an `email` to scope a profile.
This is a third required Convex addition (§11), not optional. F1–F8 work with
the current single-actor `testSend`.

### 2.2 F2-out is a TARGET, not a reused capability (will fail until built)

F2-out (outbound generated files: pdf/docx/pptx/xlsx/md/img/audio) is in the
matrix because it DEFINES the target, but it is **expected to FAIL on the first
run** — the bridge cannot yet retrieve them robustly. Today's normalizer only
PATH-SNIFFS `data.mediaUrls` / the `MEDIA:` directive (`normalizer.ts` +
`sanitize.ts`); the authoritative `artifacts.list`→`artifacts.download` pull
(decode `download.mode: bytes|url|unsupported` → Convex File Storage →
`messageParts.storageId`) is a RECOMMENDATION in `OPENCLAW_RESEARCH.md`, not
built. So F2-out reports `⛔ not-implemented` until the bridge gains artifact
retrieval; the harness row exists so that work has a ready oracle. The matrix
legend marks it distinctly (not a regression — a not-yet-built feature).

---

## 3. The runner (orchestrator)

`runner.ts` is the CLI entry. One full pass, deterministic, spaced out. Pseudocode:

```
1. loadLiveConfig()
   - read LIVE_* env (Convex URL + dev key, bridge base URL, the instance name).
   - HARD REFUSAL: if instanceName !== "olivier" (or gatewayUrl !== olivier's),
     throw before any send. (Spec invariant: live tests hit ONLY the olivier dev
     instance, NEVER jerome.)

2. ensureBridgeUp()
   - The runner OWNS a freshly-spawned bridge per run (BRIDGE_DEBUG=1, stdout
     captured from t0, §6), then polls /health (bridge/src/server.ts:168) until
     ok. It does NOT attach to a pre-existing bridge — hello-ok (the version
     oracle) is logged ONCE per connection in openclaw-client.ts `connect()`, and
     the operator socket is pooled/reused, so a long-lived bridge may have already
     emitted (and rotated past) its hello-ok line with no fresh one to parse. A
     bridge the runner spawned guarantees the hello-ok appears in THIS run's
     stdout on the first lazy connect. (Alternative if the runner must reuse a
     shared bridge: expose last-seen `server.version` on `/health` and read it
     there — flagged in §11.) The gateway connect is LAZY (on first send).

3. ensureRouted()
   - dev.routeUser({ instanceName:"admin", gatewayUrl:<olivier>, agentId:"olivier",
     canonical:"olivier" }) so dispatch resolves a target. (admin == olivier's group.)
   - For F9: routeUser a SECOND profile (email-scoped) → second owner.

4. readVersionOracle()
   - Fire ONE warm-up testSend (or reuse F1) and parse the captured hello-ok
     line → server.version. THIS string keys every fixture dir + report this run.
   - If a fixtures/<version>/ dir does not exist yet, this is a NEW version:
     create it; all captures become the new baseline (still gated by §4 oracle).

5. for each feature in registry (SERIALLY for the simple ones; see §7 for F8/F9):
   a. dev.reset() OR create a fresh chat (per-feature isolation of the oracle).
   b. sleep(feature.pacing.preDelayMs)   // SPACE the sends — don't hammer the
                                          // real agent (spec invariant).
   c. fire feature.stimulus (testSend / interleaved sends / file attach).
   d. start a frame-tap window (capture/frame-tap.ts) tagged with this feature.
   e. pollOracle(feature.oracle, timeoutMs)  // §4
   f. record MatrixCell { feature, version, status, latencyMs, divergences }.
   g. flush captured frames → fixtures/<version>/<feature>/frames.jsonl
      + diagnosis.json + oracle.json (§6).

6. runRegressionGate(version)            // §5
7. writeReports(version, runId)          // §6 report format
8. surfaceCodeChanges()                  // §9 human-review gate — NEVER auto-commit
```

Pacing is per-feature (`preDelayMs`) so the suite never bursts the live agent;
heavy features (F3/F4) get longer `timeoutMs`. The runner is idempotent: re-runs
overwrite the current-version fixtures only after the oracle passes, so a flaky
run cannot silently poison the baseline.

---

## 4. The oracle (poll Convex, with timeouts)

The oracle is **Convex state**, not the frame log (frames are evidence, not
truth). `oracle/convex-poll.ts` polls a Convex query on an interval until the
expected state holds or the deadline fires.

```ts
interface Oracle {
  // The terminal Convex state that means PASS.
  finalStatus: "complete" | "error" | "aborted";
  minAssistantTextLen?: number;            // F1/F3: non-trivial reply landed
  expectMessagePart?: { kind: "media" | "file"; mimeType?: RegExp };  // F2-out
  expectStreamingSeen?: boolean;           // F6: status passed through "streaming"
  expectToolPart?: boolean;                // F7
  routedToChatId?: string;                 // F8/F9: the reply MUST be in THIS chat
  routedToUserId?: string;                 // F9: …and owned by THIS user
}
```

Polling mechanism: a dev-gated read. Two options, both already enabled by the
dev gate:
- **Preferred:** add a tiny `dev.oracleByChat({chatId})` query returning the
  last assistant `messages` row (status/text/runId) + its `messageParts`
  (kind/mimeType/storageId-present). One read = the whole oracle. (NEW dev query
  — the only Convex addition; mirrors `searchProbe`'s dev-gated read style.)
- **Fallback (no new code):** `npx convex run` the existing `dev.searchProbe`
  for text-landed, plus `mcp__convex__runOneoffQuery` for the row/part shape.

Timeout semantics:
- Poll every `pollIntervalMs` (e.g. 500 ms) up to `feature.pacing.timeoutMs`.
- `expectStreamingSeen` is checked on the WAY to the terminal state (the F6
  "still processing" marker): the poller records the first time the row is
  `streaming`, then continues to the terminal assertion.
- On timeout: `status=failed(reason=oracle-timeout)`, capture frames anyway
  (a timeout fixture is itself diagnostic — it shows what DID arrive).

Isolation oracles (F8/F9) are the strongest: `routedToChatId` / `routedToUserId`
assert the reply landed in the right chat AND that NO OTHER chat received a
foreign assistant row in the same window (the cross-talk negative). A failure
here is flagged `SECURITY` (a routing bug = a PHI leak per the invariants).

---

## 5. The regression gate

After the current run, the gate enforces: **new fixtures green AND all prior
fixtures still green.**

Two layers — because the suite spans live behavior AND a frozen protocol surface:

**Layer A — live oracle (this version):** every registry feature must reach its
`Oracle` against the live olivier gateway at the CURRENT server.version. New
divergences (a frame family/field not seen before) are CAPTURED into the
version's fixture dir and surfaced; they do NOT silently pass — a NEW field that
breaks the normalizer fails the feature until the normalizer is extended.

**Layer B — fixture replay (all prior versions):** for every
`fixtures/<oldVersion>/<feature>/frames.jsonl` already committed, replay the raw
frames through the CURRENT `Normalizer`/`SessionMultiplexer` OFFLINE (no gateway)
and assert the same normalized projection the fixture recorded. This is the
regression bench: a normalizer change made to satisfy a NEW version must not
break the recorded behavior of any OLD version. (This reuses the existing
`bridge/test/normalizer.test.ts` fixture-replay style, generalized to read the
version-keyed dirs.)

Gate result = AND over (Layer A all-green for the new version) and (Layer B
all-green for every prior version). The loop the spec describes:

```
run live → divergence on feature X →
  capture fixtures/<newVersion>/X/frames.jsonl →
  extend Normalizer to handle the new shape →
  re-run Layer A (X green) AND Layer B (all prior versions still green) →
  repeat until BOTH layers fully green.
```

The version oracle (`server.version`) is what decides "new version": when it
changes, a fresh `fixtures/<version>/` dir is created and Layer B gains the
previous version as a frozen baseline.

---

## 6. Frame capture + report format

### Capture — reuse `BRIDGE_DEBUG=1`

No new bridge instrumentation. `openclaw-client.ts` already logs:
- `connect hello-ok` with `server.version` (the version oracle).
- `req ->` method + sessionKey ONLY (PHI-safe; no message text).
- `res ->` acks.
- `frame <-` every raw inbound frame (`dbg("frame <-", clip(frame))`).

`capture/frame-tap.ts` consumes the bridge process stdout (the runner spawns the
bridge, or tails its log file), filters lines beginning `[oc] frame <-`, and
parses the JSON. `clip()` truncates at 1200 chars; for fixtures we want FULL
frames, so the ONE optional bridge tweak is a `BRIDGE_DEBUG_FULL=1` that skips
`clip` for `frame <-` (kept dev-only, olivier-only). Without it, the harness
still works on the clipped frames for small replies; large media frames need the
full mode.

Each captured frame is tagged with the active feature's window and written as
one JSON object per line (`frames.jsonl`). PHI note: these are dev-only logs on
the olivier instance — the documented BRIDGE_DEBUG exception to the
never-log-content rule. Fixtures live in the repo for the olivier dev instance
ONLY; the README warns never to capture against jerome.

`diagnosis.json` (per feature, per run): parsed summary —
```json
{ "version": "2026.5.19", "feature": "F1",
  "frameFamilies": ["chat","agent","health"],
  "runIds": ["webchat-3f2a…"], "sessionKeys": ["agent:olivier:webchat:chat:olivier:<id>"],
  "lifecyclePhases": ["start","end"], "livenessStates": ["working"],
  "firstDeltaMs": 412, "finalMs": 2870,
  "divergences": [] }
```

### Report format — per-feature × version matrix

`reports/matrix-<version>-<runId>.json` (machine) and `reports/matrix-latest.md`
(human). The human matrix is the deliverable the user reads each version:

```
Feature × Version matrix — generated <ts>, runId <id>, oracle server.version=2026.5.19
                                  2026.5.19   2026.5.12(replay)   2026.4.x(replay)
F1  text round-trip                  ✅ 2.9s        ✅                  ✅
F2-in-flat  inbound attachment       ✅            ✅                  ✅
F2-out-pdf  outbound artifact        ⛔ not-impl    n/a                 n/a
F3  long / big paste                 ✅ 11.4s       ✅                  ✅
F4  compaction discard+replay        ✅            ⚠ captured-new      n/a
F5  archived-session reconcile       ✅            ✅                  ✅
F6  wait markers (streaming seen)    ✅            ✅                  ✅
F7  tool display toggle              ✅            ✅                  ✅
F8  parallel routing (1 user)        ✅            ✅                  ✅
F9  multi-user parallel              ✅            ✅                  ✅
Legend: ✅ pass · ❌ fail · ⚠ divergence-captured · ⏭ skipped(method-absent) · ⛔ not-implemented (target only) · n/a no fixture
```

Columns: the live column (current server.version) + one replay column per prior
fixture version (Layer B). A ❌ or ⚠ links to the feature's `diagnosis.json`.

---

## 7. Driving parallel-routing (F8) + multi-user (F9) DETERMINISTICALLY

The hard requirement: prove no cross-talk WITHOUT relying on timing luck. The
determinism comes from the oracle being **per-(chat, owner) Convex state**, not
from frame interleaving — so even if frames arrive interleaved, the assertion is
on where each reply LANDED, which is stable.

**F8 — one user, parallel conversations:**
1. Create two chats A and B for the same routed user (distinct `chatId` →
   distinct `sessionKey`: `…:chat:olivier:A` vs `…:chat:olivier:B`).
2. Fire `testSend({chatId:A, text:"<marker-A>"})` and
   `testSend({chatId:B, text:"<marker-B>"})` close together (small or zero
   `preDelayMs`) to FORCE concurrent in-flight turns on ONE operator socket —
   exactly the multiplex path (`SessionMultiplexer.feedFrame` fanning by
   `payload.sessionKey`).
3. Use DISTINCT, content-correlatable prompts so the agent's replies are
   distinguishable (e.g. "reply with the word ALPHA only" / "BRAVO only").
4. Oracle (PRIMARY = structural): each chat has exactly one assistant final, and
   the frames that produced it carried THAT chat's own `sessionKey`
   (`frameSessionKey` → `chatId`, the routing key the bridge actually uses in
   `multiplex.feedFrame`). This holds even if a real LLM ignores "reply ALPHA
   only", so it never passes vacuously. Content markers (ALPHA/BRAVO) are
   CORROBORATING: A's final ideally contains ALPHA and NOT BRAVO. The structural
   sessionKey match is the proof; the markers are a human-readable cross-check.

**F9 — two users, parallel:**
1. `routeUser` a second profile (email-scoped) → owner U2 with its own canonical.
2. Two chats, one per user; each user fires several `testSend` interleaved.
3. Oracle adds `routedToUserId`: each reply must be owned by the correct user
   (`messages.userId`) AND in the correct chat. The negative cross-talk check is
   cross-USER here — flagged `SECURITY` on any leak, since the gateway gates by
   operator.read scope, not user, so the bridge's sessionKey routing is the ONLY
   isolation boundary (per `OPENCLAW_CONNECTION_MODEL.md` §Q4 / `multiplex.ts`).

Determinism levers (structural-first, never clock-based):
- PRIMARY: the sessionKey→chatId match (the bridge's real routing key); a reply's
  frames must carry the chat's own sessionKey. Independent of agent obedience.
- per-(chat, owner) oracle reads (no global "did SOME reply arrive").
- distinct content markers per turn (ALPHA/BRAVO/…) as a CORROBORATING check.
- the negative assertion (foreign content absent from each chat) is what
  upgrades "looks routed" to "provably isolated".
- to stress the multiplex without a race condition in the TEST, fire the
  concurrent sends, then poll EACH chat's oracle independently to completion —
  order of completion does not affect pass/fail.

A pure-offline companion already exists: `multiplex.test.ts`
(interleaved-no-cross-talk, unknown-session-drop). F8/F9 are the LIVE
counterparts; the offline test is the fast regression, the live test is the
real-gateway proof. Captured F8/F9 interleaved frames also become Layer-B
fixtures, so the isolation guarantee is re-replayed on every future version.

---

## 8. Compaction (F4) + history reconciliation (F5) — the honest oracle

Per `OPENCLAW_RESEARCH.md`, the compaction signal is the riskiest unknown: the
normalizer today keys discard-and-wait on the UNTYPED lifecycle
`data.livenessState==='abandoned'`, which has NEVER been observed live (only
`'working'`), while the protocol ALSO carries a TYPED
`sessions` `{operation:'compact', phase:'start'|'end'}` op event and
`sessions.compaction.*` RPCs.

The harness treats this as a capture-first feature:
- F4 drives a long same-chat conversation past the threshold to PROVOKE
  compaction, captures EVERY frame in the window, and the diagnosis records BOTH
  candidate signals (`livenessState` values seen, AND any typed `sessions`
  compact op). The oracle asserts the FINAL assistant row reflects the replayed
  run (not a truncated partial) — independent of WHICH signal fired.
- The captured fixture then SETTLES which field is authoritative on this
  version. If the live frame uses the typed `sessions` op (or a different
  field), the normalizer is corrected and the change is surfaced for review;
  the old behavior stays green via Layer B.
- F5 reconciles against `chat.history` (display-normalized) and asserts the
  webchat `messages` match OpenClaw's real post-compaction context (no phantom/
  missing turns) — the CRITICAL "OpenClaw's real context == what the user sees".

This is the honesty rule in action: the harness does not assume the
`abandoned`/`replayInvalid` shape; it captures the real frame and lets the
fixture be ground truth.

---

## 9. Human-review gate (NEVER auto-commit)

The harness NEVER commits. Its outputs are:
1. fixture dirs (`bridge/live/fixtures/<version>/…`) — new captures.
2. reports (`bridge/live/reports/…`).
3. a `CHANGES.md` (or stdout summary) listing any normalizer/code change the
   loop required to turn a feature green, as a DIFF to review.

When a divergence forces a normalizer extension, the runner stops at the gate,
prints the proposed diff + the fixture that motivated it, and leaves the working
tree dirty for the user to inspect, run, and commit themselves. No `git commit`,
no `git push` (spec invariant + global rule). The README states this explicitly.

---

## 10. Commands (operator)

```bash
# 0. bridge up (lazy gateway connect; version oracle read on first send)
cd bridge && npm run build && BRIDGE_DEBUG=1 BRIDGE_DEBUG_FULL=1 \
  node --env-file=.env dist/index.js          # listens :8787

# 1. wire routing once (olivier instance ONLY)
CONVEX_AGENT_MODE=anonymous npx convex run dev:routeUser \
  '{"instanceName":"admin","gatewayUrl":"wss://gateway.lacneu.com","agentId":"olivier","canonical":"olivier"}'

# 2. full live matrix (all features, current version, + Layer-B replay of priors)
cd bridge && npm run live

# 3. one feature (during the green-the-feature loop)
npm run live -- --feature F4

# 4. replay-only (offline regression; no gateway) — Layer B alone
npm run live -- --replay-only
```

`npm run live` (new script in `bridge/package.json`) = `tsx live/runner.ts`.
`--replay-only` runs Layer B without touching the gateway (fast CI-style gate).

---

## 11. Open design choices (flag for the user)

REQUIRED Convex additions (not optional — the harness cannot run all features
without them), all dev-gated like the rest of `dev.ts`:
- **`testSend` actor selector** (§2.1) — optional `email`/`canonical`/`asUserId`
  on `dev.testSend` (or a `dev.testSendAs`) so F9 can direct a turn to the SECOND
  routed profile. Without it F9 is undrivable (current `testSend` always fires as
  the first `overrideInstance` profile and rejects foreign chats).
- **`dev.oracleByChat({chatId})`** — returns the last assistant `messages` row
  (status/text/runId) + its `messageParts` (kind/mimeType/storageId-present), so
  the oracle is one read. Alternative: compose `searchProbe` + `runOneoffQuery`
  (no new code, more brittle). Recommendation: add the dedicated query.

Open choices:
- **`BRIDGE_DEBUG_FULL=1`** (skip `clip` for `frame <-`) is needed only for
  large media frames; small-reply features work on clipped frames. Recommendation:
  add the flag, dev-only.
- **Frame-tap transport:** parse the bridge's stdout (simplest, zero coupling)
  vs. a dev-only in-process frame sink the bridge writes to a file. stdout-parse
  is recommended first; promote to a file sink only if interleaving makes stdout
  parsing fragile under F8/F9 concurrency.
- **F4 provocation cost:** genuinely provoking compaction burns real agent
  tokens. Recommendation: gate F4/F5 behind `--heavy` so the default fast pass
  (F1–F3, F6–F9) stays cheap, and run `--heavy` deliberately per version.
- **Version-oracle source:** runner-spawned bridge (read hello-ok from this
  run's stdout, §3 step 2) vs. exposing last-seen `server.version` on `/health`.
  The spawned-bridge route is recommended (no bridge change); the `/health`
  field is the fallback if the runner must reuse a shared long-lived bridge.

---

## Notes on this deliverable (grounding + verification)

This design is written to `docs/LIVE_HARNESS_DESIGN.md` (durable). Every cited
primitive was verified against the current code:
- `convex/dev.ts` — `testSend:356` (first-`overrideInstance` actor resolution at
  line 364, foreign-chat rejection at line 374), `routeUser:284` (optional
  `email` selector), `reset:414`, `searchProbe:244`. All confirmed verbatim.
- `bridge/src/providers/openclaw/openclaw-client.ts` — hello-ok / `server.version`
  log at lines 253-265 (`connect hello-ok | server.version=`), raw frame capture
  at line 325 (`dbg("frame <-", clip(frame))`). Confirmed.
- `bridge/src/server.ts` — `GET /health` at line 168, `POST /send` /
  `performSend` at line 116. Confirmed.

The four advisor corrections from the prior review are present: §2.1 (testSend
actor selector as a BLOCKER for F9), §3 step 2 (runner-owned bridge to avoid the
pooled-socket hello-ok miss), §7 (structural sessionKey→chatId assertion as
PRIMARY for F8/F9, markers corroborating), §2.2 (F2-out as a TARGET reporting
`⛔ not-implemented`, with the §2.2 glyph aligned to the §6 legend in this pass).