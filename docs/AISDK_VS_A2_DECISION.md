# AI SDK UI vs. Decision A2 — should `openclaw-webchat` adopt the Vercel AI SDK?

**Status:** decided. **Verdict: KEEP A2 (Convex as sole browser transport) + keep
assistant-ui as the render layer. Confidence: HIGH.**
**Date:** 2026-06-03 (lead-reviewed 2026-06-04). **Scope:** the frontend transport +
render layers only; does not touch the bridge worker, schema, or secret-store
decisions (B1/C1).

> **Independent re-verification (lead, 2026-06-04).** The load-bearing fact was
> re-checked verbatim against the PUBLISHED type defs at
> `unpkg.com/ai@6.0.196/dist/index.d.ts`: `interface ChatTransport` contains
> **exactly** `sendMessages` (trigger `submit-message`/`regenerate-message`) and
> `reconnectToStream(chatId)` — no push/subscribe. The `pushMessage(message)`
> method is on a **separate** `interface ChatState` (local client-state, next to
> `popMessage`/`replaceMessage`) — i.e. precisely the transport-bypassing escape
> hatch §3.3 already accounts for. (Note: the workflow's 2-skeptic Verify phase
> marked this claim "refuted" — an artifact of skeptics told to default to
> "refuted" when they couldn't re-confirm within budget, plus one verifier that
> errored; superseded by this direct package read. The verdict rests on the
> verbatim type, not the skeptic vote.)

This memo was written to be *overturnable*: the explicit instruction was to flip A2
if AI SDK UI can cleanly model (a) the assistant emitting post-turn with no prior
user send, (b) a multi-device shared live stream, and (c) discard+replay on
compaction, via a Convex-backed transport. It does not. The reason is structural
and verified against primary source across two release tags. The flip condition is
named concretely in §6 so the door stays genuinely open.

---

## 1. TL;DR verdict + confidence

- **Transport: settled, do not change. Confidence HIGH.** Convex's reactive
  WebSocket query stays the SOLE browser transport. The AI SDK UI `ChatTransport`
  interface has exactly two methods, both driven by *client* triggers, with **zero
  server-push surface** — verified verbatim in `ai@6.0.196` (latest) and
  `ai@7.0.0-beta.116` (beta). It structurally cannot originate a stream the user
  did not start, which is exactly what an event-driven gateway requires.
- **Render: a separate, weaker, reversible choice. Keep assistant-ui today.
  Confidence MEDIUM-HIGH.** assistant-ui's `ExternalStoreRuntime` is purpose-built
  for an externally-owned reactive store — which is precisely the A2 model, and is
  what the repo already runs (`src/chat/useConvexChatRuntime.ts`).
- **"Switch to the AI SDK" is a false binary.** assistant-ui and AI SDK UI are not
  mutually exclusive: `@assistant-ui/react-ai-sdk` is *layered on*
  ExternalStoreRuntime, and Convex's own `@convex-dev/agent` reuses the AI SDK
  `UIMessage` *types* over a reactive socket. The legitimate forkability/familiarity
  win the AI SDK offers is available **at the render layer without ceding
  transport** (the "hybrid" path, §6) — but it is not needed today and is not the
  recommendation.
- **The genuinely strong pro-AI-SDK fact** (`setMessages` can feed useChat
  unprompted messages from a Convex query) is real but does not move the verdict: it
  *bypasses the transport*, so Convex still does 100% of the hard work, and it is
  mechanically-possible-but-unblessed. §3 handles it honestly.

**Recommendation: `keep_A2_assistantui`.**

---

## 2. Layer analysis — what is even in play

The AI SDK is three layers. Only one is relevant here, because **OpenClaw IS the
agent**: it calls the models, orchestrates tools and subagents, and emits a
normalized event stream. The bridge worker RELAYS that stream into Convex; it never
calls an LLM.

| AI SDK layer | What it is | Relevance here |
|---|---|---|
| **AI SDK Core** (`streamText`, providers, tool orchestration) | The "very complete, well-supported" part — model providers, tool loops, agents | **N/A.** OpenClaw already does all of this. There is no LLM call, no provider, no tool loop on our side to delegate to the SDK. Scoping this out is deliberate, not an oversight: it is the layer the community is large for, and it has near-zero surface in a relay. |
| **AI SDK UI** (`useChat`, `ChatTransport`) | Client chat-session state + transport | **The only layer in play** — and the subject of this memo. |
| **AI SDK render** (`UIMessage` types, `@ai-sdk/react` parts) | Message/part shapes for rendering | Compatible and reusable independent of transport (see §4). |

So the real question is narrow: **does AI SDK UI's `useChat` model a shared,
externally-owned, post-turn-emitting reactive store better than what A2 already
has?** It does not, and the comparison is therefore AI SDK UI vs. assistant-ui's
runtimes — where assistant-ui is purpose-built for the externally-owned store.

---

## 3. The crux — does `useChat` model a shared reactive post-turn-emitting store?

**Verdict: NO. `useChat` is fundamentally a per-client, client-INITIATED
request→response session.** It is not a server-initiated, multi-device, shared-live-
stream primitive. This is the load-bearing finding and it survived adversarial
refutation against the published source.

### 3.1 The transport interface has no server-push surface (HIGH confidence)

The `ChatTransport` interface (verbatim from `packages/ai/src/ui/chat-transport.ts`,
confirmed identical across `ai@6.0.196` latest and `ai@7.0.0-beta.116` beta) has
**exactly two methods**:

- `sendMessages({ trigger: 'submit-message' | 'regenerate-message', chatId,
  messageId, messages, abortSignal, ... }) => Promise<ReadableStream<UIMessageChunk>>`
- `reconnectToStream({ chatId, ... }) => Promise<ReadableStream<UIMessageChunk> | null>`

Both are **client-pulled**. `sendMessages` only fires on a `submit-message` or
`regenerate-message` trigger — i.e. the user (or an explicit regenerate) starts every
stream. `reconnectToStream` re-attaches a client to its OWN prior generation by
`chatId`. **There is no method by which an externally-owned store pushes a
server-initiated assistant message into `useChat`.** OpenClaw's defining behavior —
emit AFTER the turn, deliver async tool/media post-turn, REPLAY a run on
auto-compaction, plus a voice/telephony side-branch that originates turns with no
browser send — has no entry point through this interface.

### 3.2 "Resumable streams" are not multi-device state sync (MEDIUM-HIGH)

AI SDK "resumable streams" (`ai-sdk.dev/docs/ai-sdk-ui/chatbot-resume-streams`, v6;
backed by the `resumable-stream` package + Redis pub/sub) are a **reconnect-after-
reload** feature for a *user-started* generation. "Multiple clients can connect to
the same stream simultaneously" means fan-out of ONE in-flight, POST-initiated
generation's tokens via Redis — not persistent cross-device sync of finalized
conversation state, and not a server-initiated subscription. The stream is always
born from a user POST + `streamText`; the GET reconnect returns `204` when no
active stream id exists. It requires Redis + a DB chatId mapping to even approximate
what Convex gives for free. It cannot model discard+replay (compaction): the docs
cover reconnect and abort-as-disconnect, and say nothing about discarding a partial
and restarting a run mid-stream. **(UNKNOWN, marked honestly: no primary source
documents repurposing reconnect for compaction replay — treat as unsupported, not
as a maybe.)**

### 3.3 The escape hatch — `setMessages` — is real, and here is why it doesn't flip A2 (HIGH that it works; LOW that it's blessed)

This is the strongest pro-AI-SDK evidence, so state it plainly: `useChat` exposes
`setMessages` (`@ai-sdk/react@3.0.198` `UseChatHelpers.setMessages`), which is
independent of the transport and notifies React via `useSyncExternalStore`. So an
external feeder — e.g. a Convex `useQuery` → `setMessages` effect — **CAN** render
unprompted assistant messages in a `useChat` UI. Mechanically it works (verified in
source).

It still does not move the verdict, for three reasons:

1. **It bypasses the transport entirely.** Every hard property A2 needs —
   server-initiated emission, multi-device fan-out, discard+replay — is then
   provided **by Convex**, not by the AI SDK. `useChat` contributes nothing to the
   problem it was supposed to solve.
2. **It is strictly *more* layers than the current design for zero transport gain.**
   The repo already drives an externally-owned reactive store directly via
   `useExternalStoreRuntime(adapter)` where `adapter.messages = useQuery(...)`. Piping
   the same Convex query through `setMessages` into a `useChat` instance adds the
   entire `useChat` state machine and its dormant transport on top, to render the
   same data.
3. **It is mechanically-possible-but-unblessed.** The docs frame `setMessages` as
   "programmatically update history", not as the primary input path; no official
   example drives an entire server-pushed conversation through `setMessages`.
   Confidence it WORKS: high. Confidence it is a SUPPORTED pattern: low.

That asymmetry — more layers, no transport gain, unblessed usage — is the honest
kill. The escape hatch proves the door is unlocked; it does not give a reason to
walk through it.

### 3.4 No real-world precedent for the regime we need (HIGH on absence, with the standard caveat)

No primary source shows `useChat` (or `useUIMessages`) driven from an externally-
owned, **server-INITIATED** reactive stream where the assistant emits with no prior
`sendMessage`. Convex's own agent flow still originates from a user-triggered thread
message. The closest community attempts to make `useChat` ingest a server-pushed
stream (vercel/ai Discussion #5139, Issues #415 / #7109) converge on heavy
workarounds: "build your own protocol because useChat won't work with custom
protocols", or "fork `useChat` and `processChatResponse`." Separately, vercel/ai
Issue #11865 (open, Jan 2026) shows even `resume:true` reconnection breaks on
tab-switch/backgrounding — i.e. the cheap multi-device reactivity A2 gets for free is
a known weak spot in `useChat`. (Absence of public precedent is not proof of
impossibility — only of no documented, forkable prior art. But for a *public,
forkable* project, "no forkable prior art for this exact regime" is itself a cost.)

---

## 4. Convex × AI SDK + assistant-ui interop reality

The decisive interop fact dissolves the "either/or": **transport and render are
decoupled, by Convex and by assistant-ui themselves.**

- **Convex's own product keeps the reactive query as transport and reuses AI SDK
  *types* at render.** `@convex-dev/agent` streams assistant text "over
  websockets… without http streaming" and tells the frontend to render via
  Convex-reactive hooks (`useUIMessages` with `stream:true`, `useThreadMessages`),
  with `toUIMessages` explicitly "a helper that transforms MessageDocs into AI SDK
  `UIMessage`'s" (`docs.convex.dev/agents/messages`, `get-convex/agent`). This is the
  close analog of A2: AI SDK `UIMessage` types at the render layer, reactive query as
  transport. (Version timeline is MEDIUM confidence; the current package aligns to AI
  SDK v6 and streams via reactive websockets — the precise cutover/dates are unpinned.)
- **Convex's recommended streaming pattern matches A2's rationale almost verbatim.**
  `stack.convex.dev/gpt-streaming-with-persistent-reactivity`: persist chunks to the
  DB incrementally, clients subscribe via `useQuery`; stated benefits are persistence
  across browser close, "multiple browsers can be subscribed to updates", refresh
  "picks up the latest", and parallel requests "from the same or multiple users."
  Those ARE A2's multi-device + reconnect + persistence arguments.
- **Do not conflate the two Convex patterns.** `@convex-dev/agent` = pure reactive,
  no per-turn HTTP stream (validates A2). `@convex-dev/persistent-text-streaming` =
  HYBRID: it opens a per-turn HTTP stream for the originating client, THEN persists
  chunks for others. The latter is **not** a counter-example to A2 — it still opens
  the very per-turn stream A2 rejects; only its persistence side is reactive.
- **assistant-ui interoperates with the AI SDK at the render layer.**
  `@assistant-ui/react-ai-sdk` "is layered on ExternalStoreRuntime"
  (assistant-ui.com docs), shipping `useChatRuntime` (higher-level) and
  `useAISDKRuntime` (takes a `useChat` instance you control — for sharing the chat
  with non-assistant-ui code or a custom transport). It currently targets AI SDK v6
  (`ai@^6`, `@ai-sdk/react@^3`). So adopting assistant-ui **already buys an
  AI-SDK-render-layer path** if contributors ever want it — without making AI SDK the
  browser transport.
- **No turnkey first-party Convex × assistant-ui example exists** (grep of the full
  assistant-ui docs corpus for "convex" = 0 hits). The Convex path is a *documented
  composition* (ExternalStoreRuntime + Convex's reactive query; Convex also ships a
  TanStack Query adapter `@convex-dev/react-query` if a `useQuery` bridge is wanted),
  not a blessed turnkey runtime. The repo already implements the direct composition,
  so this is a known, not a gap.

**Net:** the AI SDK that genuinely applies here is its render *types* (`UIMessage`),
which are transport-agnostic and already compatible with a Convex-reactive store. Its
transport is the thing every serious Convex integration *replaces*.

---

## 5. The forkability / familiarity argument, weighed honestly

This is the strongest *legitimate* case for the AI SDK, and it deserves a fair
hearing: the AI SDK has ~5M weekly downloads, contributors know `useChat`, and a
public forkable project benefits when its stack is familiar. Taken at face value,
"contributors already know AI SDK" is a real maintenance asset.

**But the argument inverts precisely in the regime this gateway needs.** Vanilla
`useChat` is familiar; this project does not use vanilla `useChat`. To make `useChat`
serve an event-driven, post-turn, multi-device, replay-on-compaction gateway, the
documented paths are (a) a hand-built custom protocol or (b) a **fork** of `useChat`
/ `processChatResponse` (Discussion #5139, Issues #415/#7109). A forked `useChat` is
*less* familiar to a contributor than vanilla `useChat` — they would have to learn
our fork's divergence on top of the SDK they thought they knew. **The familiarity
benefit evaporates exactly where it would have to pay off.**

Two further honest caveats that cut *against* assistant-ui (collected in §7 / Open
risks): assistant-ui's core is pre-1.0 (`@assistant-ui/react@0.14.13`, 414 published
versions — high churn), and there is no first-party Convex example. These are real
costs of the current choice. They are smaller than forking `useChat`, but they are
not zero, and a future contributor-familiarity pain point is the scenario where the
hybrid escape valve (§6) earns its keep.

Also relevant: the raw download-count comparison flatters the AI SDK because most of
that number is **Core** (providers/tool orchestration) — the layer that is N/A here
(§2). The apples-to-apples comparison is AI SDK UI (`useChat`) vs. assistant-ui
runtimes, where assistant-ui is the purpose-built tool for an externally-owned store.

---

## 6. Recommendation, decisive factors, and the flip condition

**Recommendation: `keep_A2_assistantui`.** Keep Convex as the sole browser transport
(A2) and keep assistant-ui's `ExternalStoreRuntime` as the render layer — i.e. the
design already shipped in `src/chat/useConvexChatRuntime.ts`. Do **not** adopt
`useChat` as transport. Do **not** bolt on the AI SDK render adapter today: the
current code is a clean `ExternalStoreRuntime` + `convertMessage`, and adding
`@assistant-ui/react-ai-sdk` is churn for marginal gain right now.

### Decisive factors
1. **The transport interface is structurally incapable of the required regime.** Two
   client-trigger methods, zero server-push surface, verified in latest + beta. An
   event-driven gateway needs server-initiated emission; `useChat` cannot originate a
   stream the user did not start.
2. **Transport and render are separable, so "switch to AI SDK" is a false binary.**
   Convex (`@convex-dev/agent`) and assistant-ui both reuse AI SDK render *types* over
   a reactive transport. The familiarity win lives at the render layer and does not
   require ceding transport.
3. **The `setMessages` escape hatch adds layers for zero transport gain and is
   unblessed.** Convex still does all the hard work; `useChat`-via-`setMessages` is
   strictly more machinery than the current direct ExternalStoreRuntime feed.
4. **The forkability argument inverts in this regime.** The gateway forces a forked
   `useChat` or a bespoke protocol; a fork is less familiar than vanilla `useChat`.
5. **A2 is already implemented and verified.** `useExternalStoreRuntime` backed by
   `useQuery(api.messages.listByChat)`; streaming, post-turn events, and reconnect all
   land identically as doc-patch → query-rerun → re-render. Switching is pure cost.

### The hybrid path — the cheap, reversible escape valve (not the rec)
`hybrid_aisdk_render_convex_transport` (keep Convex transport, adopt the AI SDK
*render* layer via `@assistant-ui/react-ai-sdk`'s `useAISDKRuntime` or render
`UIMessage`s directly) is the thing to reach for **first** if contributor-familiarity
ever becomes real, recurring pain — because it concedes nothing on transport. It is
reversible and well-supported by the interop facts in §4. It is not the
recommendation today because it buys nothing the current design lacks and adds a
churning dependency surface. Keep it documented as the pressure-release valve.

### The flip condition (concrete, so the door is genuinely open)
**A2 flips if a future AI SDK release ships a true server-initiated push/subscribe
transport primitive** — a `ChatTransport` (or successor) method by which an
externally-owned, server-pushed reactive store can originate an assistant stream with
no client trigger, and fan it out across devices, natively. Verified ABSENT in
`ai@6.0.196` (latest) and `ai@7.0.0-beta.116` (beta) as of 2026-06-03. If that
primitive appears AND a Convex-backed implementation of it is published/blessed, this
memo should be re-opened: at that point `useChat` could model the regime directly and
the forkability argument would stop inverting. Until then, A2 stands.

---

## 7. Sources & confidence

| # | Claim | Primary source(s) | Confidence | Notes / UNKNOWNs |
|---|---|---|---|---|
| 1 | `ChatTransport` has exactly 2 methods (`sendMessages` trigger-driven, `reconnectToStream`), zero server-push surface | `vercel/ai packages/ai/src/ui/chat-transport.ts`; published dists `ai@6.0.196` (latest) + `ai@7.0.0-beta.116` (beta), identical interface; `ai-sdk.dev/docs/ai-sdk-ui/transport` (labeled v6 Latest) | **HIGH** | Interface confirmed across two release tags; the load-bearing fact. |
| 2 | `useChat` is a per-client, client-initiated request→response session, not a server-initiated/multi-device shared store | `packages/react/src/use-chat.ts`, `chat.react.ts`, `chat.ts` (main); `ai-sdk.dev/docs/reference/ai-sdk-ui/use-chat` | **HIGH** | Survived adversarial refutation. |
| 3 | Resumable streams = reconnect-after-reload for a user-started generation (Redis pub/sub fan-out of one in-flight POST), not cross-device state sync, not discard+replay | `ai-sdk.dev/docs/ai-sdk-ui/chatbot-resume-streams` (v6); `resumable-stream` npm README | **MEDIUM-HIGH** | Mechanism consistent across sources; quotes summarizer-paraphrased. Compaction-replay repurposing = **UNKNOWN / unsupported**. |
| 4 | `setMessages` can feed unprompted assistant messages into `useChat`, independent of transport | `@ai-sdk/react@3.0.198` `UseChatHelpers.setMessages`; source `useSyncExternalStore` wiring | **HIGH it works / LOW it's a blessed pattern** | No official example drives a whole server-pushed conversation through `setMessages`. |
| 5 | `@convex-dev/agent` streams over reactive websockets (no HTTP streaming) and reuses AI SDK `UIMessage` types (`toUIMessages`) | `docs.convex.dev/agents/messages`; `github.com/get-convex/agent` | **HIGH on behavior / MEDIUM on version timeline** | Aligns to AI SDK v6; exact v5→v6 cutover dates unpinned (CHANGELOG was internally contradictory). |
| 6 | Convex's recommended streaming = persist chunks + reactive `useQuery`; rationale = persistence + multi-browser + reconnect (= A2) | `stack.convex.dev/gpt-streaming-with-persistent-reactivity` | **HIGH** | Matches A2 rationale closely. |
| 7 | `persistent-text-streaming` is a HYBRID (per-turn HTTP stream for originator + persist for others) — NOT a counter-example to A2 | `convex.dev/components/persistent-text-streaming`; `stack.convex.dev/build-streaming-chat-app-with-persistent-text-streaming-component` | **HIGH** | Still opens the per-turn stream A2 rejects. |
| 8 | Community Convex×AI-SDK integration uses `streamText` server-side only + Convex `useQuery` on the client (replaces `useChat`) | `arhamhumayun.com/blog/streamed-ai-response` (2025-04-30) | **MEDIUM** (single secondary-but-primary-authored source) | States `useChat` is "limiting for production chat UIs that need custom streaming and persistence." |
| 9 | `@assistant-ui/react-ai-sdk` is layered on ExternalStoreRuntime; ships `useChatRuntime`/`useAISDKRuntime`; targets AI SDK v6 | `assistant-ui.com/llms-full.txt` (L31925, L31932); `assistant-ui.com/docs/runtimes/ai-sdk/overview`; `registry.npmjs.org/@assistant-ui/react-ai-sdk` (1.3.31, deps `ai@^6` + `@ai-sdk/react@^3`) | **HIGH** | Settles the false dichotomy: AI SDK render-layer interop exists. |
| 10 | ExternalStoreRuntime is purpose-built for an externally-owned reactive store ("you own the state") | `assistant-ui.com/docs/runtimes/custom/external-store`; `pick-a-runtime` (two core runtimes) | **HIGH** | Reactive examples: Zustand/Redux/TanStack Query. |
| 11 | assistant-ui maturity: ~10.4k stars, 1050 forks, MIT, active; core `@assistant-ui/react@0.14.13` (pre-1.0), 414 versions (high churn) | GitHub API (`assistant-ui/assistant-ui`); `registry.npmjs.org/@assistant-ui/react` | **HIGH** | Pre-1.0 churn is a real cost (Open risk). |
| 12 | Making `useChat` ingest server-pushed streams converges on forking `useChat`/`processChatResponse` or a bespoke protocol; reconnect breaks on tab-switch | vercel/ai Discussion #5139; Issues #415, #7109, #11865 (open, Jan 2026) | **MEDIUM-HIGH** | Discussion #5139 via WebSearch summary (raw URL 404'd); pattern corroborated by the issues. |
| 13 | No first-party Convex × assistant-ui example (documented composition only) | grep of `assistant-ui.com/llms-full.txt` for "convex" = 0 hits | **HIGH** | Bridge = ExternalStoreRuntime + Convex reactive query (already in repo). |
| 14 | No documented precedent for an event-driven, server-initiated, multi-device gateway on `useChat` | Absence across all searched primary sources | **MEDIUM** (absence-of-evidence) | Not proof of impossibility; but no forkable prior art for a forkable project is itself a cost. |

### Open risks (carried, not blockers)
- **assistant-ui is pre-1.0** (`0.14.x`, 414 versions) — API churn over the project's
  lifetime is real and unquantified; `react-ai-sdk` tracks AI SDK majors (`ai@^6`).
- **No first-party Convex × assistant-ui turnkey runtime** — the path is a documented
  composition; real-world reliability of that composition for the streaming/live-token
  case is not demonstrated by a primary source (though the repo runs it today).
- **The `setMessages`-bypass is mechanically possible but unblessed** — if a future
  refactor leaned on it, it could break across AI SDK minors without warning.
- **Transport-interface version pinning** — confirmed across `6.0.196` + `7.0.0-beta.116`;
  a future major could change it (that is also the flip condition, §6).
- **Compaction-replay on any AI SDK reconnect primitive is UNKNOWN** — treated as
  unsupported; A2 handles replay via Convex (discard partial, re-render on the
  authoritative doc), which is the safe path regardless.

---

*Cross-references: `docs/PROJECT_STATE.md` §5.2 (A2 confirmed),
`docs/BRIDGE_ARCHITECTURE.md` (streaming scope), `src/chat/useConvexChatRuntime.ts`
(the shipped A2 implementation whose inline comment already states this rationale).*
