# Session continuity: aligning OpenClaw sessions with the webchat's "always-in-context" UX

**Question.** OpenWebUI and our webchat **persist + display the whole conversation**,
so the user believes the LLM still has every earlier message in context. But
OpenClaw runs **ephemeral sessions** that expire; once a session has rolled, the
model's context no longer contains those older messages. A user replying to a
2-day-old thread (their "latest message") talks to an LLM that no longer has the
thread. How do we bring OpenClaw's session behaviour back to the user's mental
model — realistically, operationally, robustly?

Researched 2026-06-05 against the in-container OpenClaw docs (5.19 + the 6.1
`hello-ok` method set), docs.openclaw.ai, and community issues. Verbatim doc
quotes + issue numbers below.

---

## 1. How OpenClaw sessions actually work (grounded)

**Two persistence layers** (`reference/session-management-compaction.md`):
1. **`sessions.json`** — `sessionKey → SessionEntry` (current `sessionId`, last
   activity, token counters, toggles). Small, mutable.
2. **Transcript `<sessionId>.jsonl`** — append-only conversation + tool calls +
   compaction summaries. *"Used to rebuild the model context for future turns."*

Our bridge keys each chat to `agent:<agent>:webchat:chat:<canonical>:<chatId>` — a
**thread-scoped chat session**. Within one `sessionId` the transcript rebuilds the
model context, so continuity works… until the session rolls.

**Lifecycle / why context is lost** (`concepts/session.md`):
- **Daily reset (DEFAULT): a new `sessionId` at 4:00 AM** gateway-local. "Daily
  freshness is based on when the current `sessionId` started."
- **Idle reset (optional):** new session after `session.reset.idleMinutes` of no
  real user interaction.
- **Manual:** `/new`, `/reset`.
- On a roll, the **old transcript is archived** (`*.reset.<ts>`) and the next turn
  starts a **fresh `sessionId` with no prior context**. The on-disk history is
  preserved, but **what the model sees** is reset.

**Within a live session, two trimmers run:**
- **Pruning** (`concepts/session-pruning.md`) — trims **old tool results** in-memory
  (not the transcript). Also a "replay view" that replaces already-processed
  inbound images with `[image data removed - already processed]` after the 3 most
  recent turns.
- **Compaction** (`concepts/compaction.md`) — when nearing the context window,
  **summarises older turns** into a compact entry; recent turns kept verbatim.
  Auto-compaction is on by default. *"The full conversation history stays on disk.
  Compaction only changes what the model sees."* Before compacting, OpenClaw
  **reminds the agent to save notes to memory**.

**Memory is a SEPARATE layer** (`concepts/memory.md`, active-memory, Hindsight):
OpenClaw's intended **cross-session recall** is the memory system, NOT the session
transcript. Memory = salient facts ("who you are, your preferences, project
facts"), not the verbatim thread.

**This is a known, widespread limitation (community):**
- [#49170](https://github.com/openclaw/openclaw/issues/49170) — *Daily session reset wipes actively used sessions at the daily boundary.*
- [#32109](https://github.com/openclaw/openclaw/issues/32109) — *default reset for group/topic sessions should be idle, not daily.*
- [#27231](https://github.com/openclaw/openclaw/issues/27231) — *Backfill channel history on new session start (post idle/daily reset)* ← exactly the rehydration we need.
- [#43524](https://github.com/openclaw/openclaw/issues/43524) — *Daily reset doesn't trigger the session-memory hook flush* (so memory ALSO misses daily-reset context).
- [#73546](https://github.com/openclaw/openclaw/issues/73546) — *client reconnect creates a new session instead of resuming* (relevant to bridge reconnects).
- [#31322](https://github.com/openclaw/openclaw/issues/31322) — *silent daily session resets and data loss.*

**Takeaway.** OpenClaw's session ≠ a permanent conversation. It is an ephemeral
working context (daily/idle reset + compaction + pruning) plus a separate memory
layer. The daily-reset behaviour is buggy enough that even OpenClaw's own memory
hook misses it. **We cannot rely on the OpenClaw session as the durable context.**

---

## 2. The decisive insight

**WE already own the durable, complete, displayed conversation** (Convex/webchat).
So the robust answer is to invert the authority: **the bridge — not the OpenClaw
session — is the source of truth for context.** The bridge guarantees that, on any
turn, the OpenClaw session reflects what the user sees. OpenClaw's session
lifecycle (daily reset, reconnect-new-session, pruning) then becomes irrelevant to
the UX. This is also exactly the community's requested feature ([#27231]), which we
implement ourselves instead of waiting for upstream.

---

## 3. Recommended architecture — 3 layers

### Layer 1 — Reduce unnecessary rolls (config mitigation, cheap)
Configure the webchat agent's `session.reset` to **idle-based with a long window
(or disable daily)** so a casual return does not roll the session (community
consensus [#32109]):
```json5
{ session: { reset: { daily: false, idleMinutes: 1440 } } } // tune per policy
```
Caveat: partial only — the daily-reset boundary bug ([#49170]) and reconnect-new-
session ([#73546]) can still roll it; and a never-resetting session grows until
compaction summarises old turns (lossy). **Mitigation, not the fix.**

### Layer 2 — Bridge-driven re-hydration (THE robust core)
The bridge has the full Convex conversation. Per chat it tracks the OpenClaw
`sessionId` it last used (via `sessions.describe`/`sessions.list`). On a new turn:
1. **Detect a fresh/rolled session** — `sessionId` changed, or token-count ≈ 0, or
   first turn after a gap.
2. **Re-hydrate before the user's message**: inject the prior conversation from
   Convex into the OpenClaw session so the model's context == the displayed thread.
3. **Bound the cost** — do NOT resend the full verbatim thread every turn. Inject a
   **compacted form**: the last *N* turns verbatim + a rolling **summary** of older
   turns (maintained per-chat in Convex, or generated on demand). This mirrors
   OpenClaw's own compaction philosophy and keeps tokens predictable.

**Injection mechanism (validate before building):**
- **Silent turn (`NO_REPLY`)** — OpenClaw supports "silent housekeeping" turns: the
  assistant output begins with the exact token `NO_REPLY`/`no_reply` and OpenClaw
  **strips it from delivery** (`reference/session-management-compaction.md`). A
  silent context-seeding turn establishes the conversation in the new session
  transcript with **no user-visible output**, then the real turn runs with full
  context. This is the cleanest fit ("the Gateway may rewrite or rehydrate
  entries"); confirm the exact `chat.send`/`sessions.send` shape that lands a
  silent system/context turn on 5.19 AND 6.1.
- **Alternative:** prepend the compacted history as a context/system block in the
  user `chat.send` (cruder, always-applied, more tokens; simplest fallback).

This makes the user's mental model literally true: the displayed conversation
defines the context, because the bridge enforces it.

### Layer 3 — Memory for cross-CONVERSATION recall (complementary)
Keep OpenClaw memory (active-memory / Hindsight, already running) for **salient
facts that should persist across DIFFERENT chats** (name, preferences, durable
project facts) — "what the agent knows about you", not "this specific thread".
Pre-compaction memory flush + on-resume recall cover this. Do NOT use memory for
verbatim thread continuity (it's summaries/facts) and remember it misses daily
resets ([#43524]).

---

## 4. Recommended priority + open questions

**Priority:** Layer 2 is the robust, reliable answer (decouples us from OpenClaw's
session quirks). Layer 1 is a cheap dial to reduce how often Layer 2 fires. Layer 3
is complementary.

**Open questions to validate before building (live, both versions):**
1. The exact RPC shape for a **silent `NO_REPLY` context-seeding turn** that lands
   transcript entries without delivering output — on 5.19 and 6.1.
2. Whether `sessions.describe` exposes a reliable **"session rolled / fresh" signal**
   (sessionId + token counters) the bridge can poll cheaply.
3. The **compaction/summary policy** for re-hydration: how many verbatim tail turns;
   where the rolling summary lives (Convex field per chat) and when it is refreshed.
4. Token/cost budget per re-hydration and the per-chat context-window meter (we
   already surface `totalTokens/contextTokens` in the chat header — reuse it).
5. Multi-tenant correctness: re-hydration must stay strictly within the chat's
   owner session (sessionKey isolation), never leak across users.

**Version note (tested):** the session model (daily reset, `sessions.json` +
transcript, compaction, `sessions.*` RPCs) is present on both 2026.5.19 and
2026.6.1; the `hello-ok` method set on 6.1 includes `sessions.describe`,
`sessions.patch`, `sessions.create`, `sessions.compaction.*`, `chat.history`,
`chat.startup`. Confirm the silent-turn + describe shapes per version in the
stability ledger before relying on them.

---

## 5. Live validation (2026-06-05, 6.1, poll-to-complete) — primitive chosen + proven

**NO_REPLY silent turn — REJECTED (evidence).** Instructed the agent to reply
exactly `NO_REPLY`. Result: OpenClaw delivered the raw `"text":"NO_REPLY"` to the
**operator/bridge stream** and our normalizer wrote a **visible** assistant
message. The documented stripping (`chat.history` omits `NO_REPLY`; channels
suppress it) applies to the **channel/history-display** path, **not** the live
operator stream the bridge consumes — so the bridge would have to suppress it
itself. Plus a back-to-back silent-turn + real-turn produced **two stuck-streaming
(never-finalized) turns** — the rapid-succession turn-ordering race the advisor
predicted. Two strikes → dropped.

**`chat.inject` — confirmed via docs (not yet live-tested).** `gateway/protocol.md`
+ `web/control-ui.md` + `web/webchat.md`: *"`chat.inject` appends an assistant note
to the session transcript and broadcasts a `chat` event for UI-only updates (no
agent run, no channel delivery)."* So it can seed an **assistant** note with no
agent turn — a clean alternative for injecting a single assistant-authored context
summary. (Assistant-only; cannot replay `user` turns.)

**Official continuity pattern — `sessionId` tracking.** `web/webchat.md`: the
Control UI *"remembers the backing Gateway `sessionId` returned by `chat.history`
and includes it on follow-up `chat.send` calls, so reconnects and page refreshes
continue the same stored conversation unless the user starts or resets a session."*
→ Our bridge should track + reuse the per-chat `sessionId` to maximise natural
continuity (reduces how often re-hydration fires). But it still **breaks at the
daily/idle roll** (the sessionId becomes a fresh one) — confirmed below.

**In-band prepend — VALIDATED (the chosen primitive).** On 6.1, with a **unique
nonce** to defeat memory confounds:
- **Negative control** — ask for a password never provided → agent replies
  **`INCONNU`** (no fabrication, no stale recall of that exact fact).
- **Fix** — fresh chat, prepend `[…the Vega password is GLYPH-233926-Q7…]` + the
  question, in ONE `chat.send` → agent replies **`GLYPH-233926-Q7`**.
⇒ The bridge can restore lost context by prepending it to the `chat.send` message,
and the model uses it; absent context, the model does not invent. One turn, no
suppression, no race. **This is the primary re-hydration primitive.**

**Forced-roll proof — `sessions.reset` works, but the LOCAL harness masks the bug.**
`sessions.reset {key}` rolled the `sessionId` (`36cf4d80…` → `3206de2c…`,
`totalTokens:0`, verified via `sessions.describe`). **Yet the agent still recalled
the pre-roll facts**, and a brand-new chat with NO prepend ALSO recalled them. Root
cause: in **codex-harness mode the codex app-server keeps ONE shared conversation
context across all OpenClaw sessions** (one codex process), so OpenClaw's session
lifecycle doesn't gate what the agent remembers, and chats are not context-isolated.
**This is a HARNESS artifact, not production:** the NAS runs codex in **API mode**
(and other models use OpenClaw's transcript as the only context), where the daily
roll DOES drop context — exactly the user-reported gap. So the "forgotten-after-roll"
bug cannot be reproduced in this single-codex-process harness; the **fix** (in-band
prepend) is proven environment-independently via the unique-nonce test above.

**Still to validate (needs the bridge re-hydration build + a faithful env):**
- Display cleanliness: bridge sends `history+message` to the gateway but writes
  ONLY the real user message to Convex/display (trivially separable in the bridge;
  must be verified end-to-end).
- Idempotency + rapid-turn safety (the streaming race must NOT recur with the
  single-turn prepend — expected clean since there's no extra turn).
- Long-context interaction with OpenClaw compaction (don't re-inject what the live
  session already holds; only on detected roll/fresh).
- Per-chat session isolation + multi-tenant (needs a non-codex-harness env, e.g.
  the NAS or a normal-model agent, since codex-harness shares one context).
- Both versions (mechanism is text-only → expected identical; confirm on 5.19).

---

## 6. Implementation (v1) — SHIPPED + decision-validated (2026-06-05, 6.1)

**Detection signal (probed empirically, not assumed).** `sessions.describe` returns
`{session: {...}}`. Probe across states: never-used → no `session` object; warm
(after ≥1 turn) → `systemSent: true`, `totalTokens > 0`; fresh/after `sessions.reset`
→ `systemSent: FALSE` and `totalTokens` **absent**. So `totalTokens===0` would have
been WRONG (it's absent, not 0); **`systemSent` flips synchronously + monotonically**
and is the signal. Trigger = **`!desc.session || desc.session.systemSent === false`**.

**The five pieces (all behind optional-schema / additive discipline):**
1. `convex/bridge.ts` dispatch → adds `messageId` to the `/send` body (so the
   bridge can exclude the current turn from the injected history).
2. `convex/stream.ts` → `internal.stream.rehydrationContext(chatId, excludeMessageId?)`:
   bounded tail read (80), keeps only `complete` user/assistant turns with text,
   excludes the current message + streaming/empty rows, budgets by the chat's known
   window (`sessionMeta.contextTokens` × 0.5 reserve, ≥2k floor), keeps the most
   recent turns (older dropped with a `[…début omis…]` notice), returns a delimited
   `Utilisateur :/Assistant :` block or `null`.
3. `convex/bridge_ingest.ts` → ingest op `getRehydrationContext` (traces metadata
   only: `rehydrated` bool + `turnCount`, never the history text/PHI).
4. `bridge/src/convex-writer.ts` → `ConvexWriter.getRehydrationContext(...)` (+ fake stub).
5. `bridge/src/server.ts` `performSend` → before `chat.send`: `sessions.describe` →
   if fresh, `getRehydrationContext` → `message = history + "\n\n" + body.text`.
   **NON-FATAL** (any failure falls back to the bare message). The visible Convex
   message stays `body.text`, so **display cleanliness is free** — re-hydration only
   enriches what the gateway sees, never the UI.

**Decision-correctness acceptance (in-harness, the testable half):** via the
`[rehydrate]` decision log, delta-counted (poll-to-complete):
- empty chat / first turn → **does not fire** (no prior history) ✓
- warm turn (`systemSent:true`) → **does not fire** ✓
- after `sessions.reset` (rolled) + has history → **fires once, prepended N prior
  turns** ✓
- turn after re-hydration (session warm again) → **does not fire** ✓ (idempotent:
  once per roll, never per turn)
- visible Convex user message never contains the injected `[Reprise…]` block ✓
Gates: `tsc(convex)` 0, `bridge build` 0, `bridge vitest` 42, `convex vitest` 103.

**Unit test (version-independent logic).** `convex/rehydration.test.ts` (6 tests,
convex-test) pins the pure builder: empty→null; chronological `Utilisateur:/
Assistant:` format + header/footer; excludes the current message
(`excludeMessageId`); skips streaming/incomplete + empty rows; ignores `system`
rows; budget truncation keeps the MOST-RECENT turns + emits the `[…début omis…]`
notice. This is the half that is identical on every OpenClaw version.

**Multi-version coverage (the version-sensitive half).** The detection signal +
the prepend were re-validated on BOTH tested versions: `sessions.describe.session.
systemSent` is **`true` when warm / `false` when fresh** on **2026.5.19 AND
2026.6.1** (identical), and the 4-case decision-acceptance (empty→0, warm→0,
reset→1 prepended-4, warm-after→0) passes **identically on both**. So the trigger
is version-stable; the feature works on every OpenClaw version in the matrix.

**The OUTCOME half — deferred to the NAS (stated, not hidden).** The mechanism
("prepend → model uses the context") was already proven with a unique nonce
(§5). The end-to-end "agent forgot, then remembered after re-hydration" **cannot be
staged in this harness** because codex-harness shares ONE context across sessions
(it never forgets here). On the NAS (codex **API** mode) / normal-model agents the
session IS the only context, so the roll really drops it — that is the environment
where the full before/after proof + per-chat isolation must be signed off.

**Remaining (v2 / sign-off):** (a) ✅ DONE — `convex/rehydration.test.ts`; (b) rolling
**summary** of older turns instead of verbatim-only (cheaper for very long threads);
(c) **media** re-hydration (v1 is text-only — earlier image/file turns survive only
as their text trace); (d) optional `sessionId` tracking to reduce describe calls;
(e) the NAS before/after + isolation sign-off (§7).

---

## 7. NAS sign-off checklist (the OUTCOME proof the harness can't give)

**Why the NAS.** The local harness runs codex in **harness mode** (one shared codex
app-server context across all OpenClaw sessions), so the agent never actually forgets
and chats are not context-isolated — the bug can't be staged, only the DECISION is
testable locally (done, both versions). The NAS runs codex in **API mode** where the
OpenClaw session transcript IS the only context, so the daily/idle roll really drops
it. That is where the end-to-end OUTCOME + isolation must be signed off.

**Pre-req:** NAS bridge updated to this build (the 7 changed files), Convex deployed,
the NAS gateway version recorded in the ledger. (No socat sidecar needed on the NAS —
it connects over **wss**, already a trusted transport.)

**Sign-off cases (each with a UNIQUE nonce per run to defeat memory confounds):**
1. **Before/after a real roll.** Turn 1: state a unique fact (`nonce A`). Force a roll
   (`sessions.reset` on the chat's key, or wait for the 4 AM daily reset).
   - 1a CONTROL (re-hydration OFF / a chat with no prior history): after the roll, ask
     for `nonce A` → agent must **NOT** know it (proves the gap is real in API mode).
   - 1b FIX (re-hydration ON): after the roll, ask for `nonce A` → agent **recalls** it,
     and the bridge log shows `[rehydrate] … prepended N`. ⇒ the displayed conversation
     is restored as context.
2. **Per-chat isolation.** Chat X learns `nonce X`; chat Y (different chatId → different
   sessionKey) asks for `nonce X` → must be **INCONNU**. Re-hydration must never pull
   another chat's history (sessionKey scoping + the chatId-scoped query).
3. **Multi-tenant.** Repeat (2) across two DIFFERENT users → no cross-user leak
   (the dispatch routes per profile; the query is chatId-scoped; assert in audit/traces).
4. **Long thread + compaction.** A thread longer than the context window: the budget
   keeps the most-recent turns + the `[…début omis…]` notice; confirm no context-overflow
   error and a coherent reply.
5. **Warm-path cost.** Confirm re-hydration does NOT fire on warm turns (no extra prepend,
   no needless token spend) — the `[rehydrate]` log stays silent on turns 2..N of a live
   session.
6. **Both NAS versions** if the NAS runs more than one (5.19/6.1): `systemSent` semantics
   + cases 1–5 identical.
7. **Failure isolation.** Kill Convex briefly mid-turn → `getRehydrationContext` fails →
   the send still goes through WITHOUT re-hydration (non-fatal), never a 5xx to the user.

**Record** the run (version, pass/fail per case, any nonce that leaked) in
`OPENCLAW_VERSION_STABILITY.md` (openclaw-notes, private). Only after cases 1–3 pass on the NAS is
session-continuity "trustable" end-to-end; until then the local status is
"mechanism + decision proven, outcome pending NAS."

---

## Sources
- [Session management — OpenClaw](https://docs.openclaw.ai/concepts/session)
- [Session management deep dive](https://docs.openclaw.ai/reference/session-management-compaction)
- [Compaction](https://docs.openclaw.ai/concepts/compaction) · [Session pruning](https://docs.openclaw.ai/concepts/session-pruning) · [Memory](https://docs.openclaw.ai/concepts/memory)
- Issues: [#49170](https://github.com/openclaw/openclaw/issues/49170), [#32109](https://github.com/openclaw/openclaw/issues/32109), [#27231](https://github.com/openclaw/openclaw/issues/27231), [#43524](https://github.com/openclaw/openclaw/issues/43524), [#73546](https://github.com/openclaw/openclaw/issues/73546), [#31322](https://github.com/openclaw/openclaw/issues/31322)
