# Bridge Implementation Plan — Modular, Multi-Provider, Multi-Tenant

> **Status:** DESIGN — phased build plan. **Phase 0 is a hard gate:** three
> irreversible decisions need the user's explicit confirmation **before any code
> is written.** Phases 1–7 are ordered by dependency; each carries a scope, the
> exact files it touches, and concrete acceptance gates (tsc / vitest / build /
> live-verify).
>
> **Companion docs (authoritative for their area, read alongside this plan):**
> - `docs/BRIDGE_ARCHITECTURE.md` — the architecture: the `BridgeProvider` seam,
>   one-connection-per-instance multiplexing, the data model + secret-store
>   reconciliation, the streaming scope guard. This plan *executes* that design.
> - `docs/OPENCLAW_RESEARCH.md` — the grounded provider research (OpenClaw
>   v2026.5.19 protocol/fixtures, Hermes API surface) and the **HONESTY** record
>   of what is doc-confirmed vs fixture-only vs NOT FOUND. This plan never
>   invents a provider surface that doc does not list as confirmed.
> - `docs/PROJECT_STATE.md` §5.2 — the bridge worker is the major un-built
>   milestone; this plan supersedes that one-paragraph sketch with the modular
>   multi-provider/multi-tenant target.
>
> **Pin:** OpenClaw **v2026.5.19** (multi-version support OUT OF SCOPE).
> **Ground truth precedence:** the in-repo normalizer + 12 fixtures win over the
> public doc wherever they diverge (see `OPENCLAW_RESEARCH.md` divergences 1–3).

---

## How to read this plan

- **Phase 0** is a decision gate, not a build step. Nothing in Phases 1–7 may
  start until A, B, C are confirmed, because each one is *irreversible in
  practice*: A defines the browser transport contract, B defines the Convex
  schema shape (and a schema you ship is a migration you own forever), C defines
  where every per-instance secret physically lives.
- **Each phase lists its dependency.** P1 is decision-independent and is a pure
  refactor (zero behavior change) — it is deliberately first so the riskiest
  structural move (P2) lands on a clean, test-green seam.
- **Gates are the real commands**, run from repo root unless noted:
  - `npx tsc --noEmit` (frontend `src/`)
  - `npx tsc -p convex/tsconfig.json --noEmit` (Convex)
  - `npx tsc -p bridge/tsconfig.json --noEmit` (bridge worker)
  - `npx vitest run` (Convex + routing — currently 87 green)
  - `npx vite build`
  - `npm --prefix mcp test` (36 green)
  - bridge unit tests (the proven **23 normalizer tests** must stay byte-green)
  - a **live-verify** specific to the phase — never just "tests pass."
- **INVARIANTS that gate every phase** (from the architecture doc + project
  invariants): secrets live ONLY in bridge env / the bridge's own secret store —
  NEVER a Convex table or the browser; Convex stores non-secret routing metadata
  only; never log PHI / message content; schema additions to EXISTING tables are
  OPTIONAL (push must validate pre-existing rows).

---

## Requirement → phase coverage map

Every HARD REQUIREMENT maps to a phase and a gate. A requirement with no phase
is the easy miss; this table is the checklist.

| Hard requirement | Phase | Acceptance signal |
| --- | --- | --- |
| Pin OpenClaw **v2026.5.19**, no multi-version | P2 | adapter validated against the 12 captured fixtures only |
| Modular provider abstraction (perfectly pluggable) | **P1** | `BridgeProvider` interface; both adapters compile against it; core has zero OpenClaw import |
| Per connected user, route to provider A **or** B | P4 | `provider` resolved on the dispatch payload; registry picks the adapter |
| User ↔ 1+ AGENTS, exactly one **DEFAULT** | P3 (schema) + P4 (resolution) | `defaultAgentId` **pointer** ⇒ two-defaults is unrepresentable |
| User ↔ 1+ INSTANCES, **new chat asks which** | P3 + P4 | `allowedInstances.length > 1` ⇒ picker at chat creation |
| User ↔ 0+ SUBAGENTS per agent | P3 + P2 | `agents.subagents[]`; sessionKey `agent:<id>:subagent:<uuid>` |
| **Multiple secrets per instance** | **P5** | secret store group holds `{token, device_identity, ...}` per instance |
| **STREAMING decoupled** from persistence, no latency, no lost reactivity | **P0-A + P7** | live tokens fluid; Convex stays durable + reactive + reconnect-safe |
| Bridge **calls provider APIs** (e.g. list-conversations); app uses them | P2 (OpenClaw) / P6 (Hermes) | `getHistory` / `listConversations` via `conn.request`; `capabilities()` honest |
| One connection per **instance**, fan-out per session | **P2** | registry keyed by instance, not chat; per-sessionKey normalizer map |
| Progressive UI (tool status, files, run status, pickers) | P3 capabilities + P4 + later UI | `capabilities()` gates each UI affordance |

---

## Phase 0 — IRREVERSIBLE DECISIONS (confirm before any code) 🔒

> ✅ **CONFIRMED by the user on 2026-06-03 — Phase 0 gate is CLEARED.**
> - **A = A2** — Convex stays the sole browser transport; decouple by making
>   persistence cheap (un-indexed live streaming field + reconcile into
>   `messages.text` at finalize). No SSE-per-turn.
> - **B = B1** — discriminator-driven schema mix (new `agents` + `userAgents`
>   tables; `profiles.allowedInstances` array; `profiles.defaultAgentId` pointer;
>   `agents.subagents` array; instance/agent/subagent snapshot fields on `chats`;
>   optional `instances.provider`). All EXISTING-table deltas OPTIONAL.
> - **C = C1** — mounted secrets file behind a `SecretStore.getGroup(name)`
>   interface; bootstrap secrets stay in bridge env; vault (C3) is a later loader
>   swap, not an architecture change.
>
> Phases 1–7 may now proceed in dependency order. The original option analysis is
> retained below for the record.

These three decisions are **blocking**. They are self-contained below (do not
defer to the sibling docs to make the call — the relevant detail is restated
here). The matching `decisions[]` structured output mirrors this section exactly
so it can drive a confirmation prompt.

### Decision A — The streaming pattern (live tokens vs durable persistence)

**Correction to the original brief, stated up front (honesty rule, primary-source
evidence):** the brief asserts "the current bridge persists each delta via a
Convex mutation — THAT is exactly what must change." That is **already
mitigated**: `HttpConvexWriter` coalesces deltas into **one `appendDelta` per
~50 ms** flush (`bridge/src/convex-writer.ts:91-92,124,164-194`), not one
mutation per token. Designing to "stop per-token mutations" would target a
problem that does not exist.

**The real axis** (from the traced data path): **the live display path IS the
persistence path.** Tokens reach the browser *only* by being persisted —
`bridge → POST /bridge/ingest (.site) → internal mutation → messages.text patch →
search reindex → listByChat recompute → useQuery push`. There is no separate
ephemeral channel, so fluidity is floored by a per-flush cost chain with three
amplifiers:
1. **O(n) text rewrite per flush** — `stream.appendDelta` does
   `text: message.text + text` (`convex/stream.ts:132`), rewriting the whole
   growing message every flush ⇒ O(n²) bytes across a turn.
2. **Full-text reindex per flush** — `messages` has a search index on `text`
   (`convex/schema.ts:228-231`); the schema comment admits it re-indexes on each
   token patch.
3. **`listByChat` full recompute per flush** (`convex/messages.ts:66-71`).

**The discriminating constraint (Image #23):** *"Persistence + reactivity live
in Convex. No SSE-per-turn that closes, so OpenClaw can keep emitting after the
turn."* This **rules out** any per-turn browser-facing socket that closes — that
is the exact Open WebUI pipe failure mode the Convex migration escaped.
Therefore the chosen pattern **must keep Convex as the only browser transport**
and attack the cost amplifiers, NOT reintroduce a closing socket.

**Options.**
- **A1 — status quo, coarsen the flush only.** Keep the persist-as-display-path
  and just raise the flush interval. Cheapest, but leaves the O(n²) rewrite +
  reindex-per-flush amplifiers and trades latency for fluidity — does not solve
  the structural coupling.
- **A2 (RECOMMENDED) — keep Convex as the sole browser transport; decouple by
  making persistence cheap.** Persist streaming text into a dedicated
  lightweight, *un-indexed* live field / row that `useQuery` subscribes to,
  flushed coarsely; reconcile into the durable, searchable `messages.text` once
  at finalize. Preserves reactivity, durability, reconnect, and the
  `ConvexWriter` seam; removes the O(n²) + reindex-per-flush amplifiers; **no
  SSE-per-turn.**
- **A3 (DISFAVORED) — a separate bridge→browser ephemeral/SSE channel for live
  tokens.** Streams tokens off the Convex path entirely, persisting only at
  finalize. **Rejected:** this is exactly the SSE-per-turn-that-closes pattern
  Image #23 rules out — it reintroduces the Open WebUI pipe failure mode (socket
  closes, OpenClaw can't keep emitting after the turn) the Convex migration
  escaped, and adds a second browser transport to keep reactive/reconnect-safe.

**Recommendation: A2** — it is the only option that both kills the cost
amplifiers AND honors the discriminating constraint (Convex stays the sole
browser transport; no closing per-turn socket).

> Why this is irreversible: it fixes the browser transport contract and the
> `messages`/`stream` write shape. Changing it later means re-touching every
> persisted message and the reactive read path. The provider interface
> (P1) is deliberately built so the live-token channel plugs in **behind** the
> `RunManager → ConvexWriter` boundary and does not leak into `BridgeProvider`.

### Decision B — The Convex schema shape (tables vs arrays; chat ↔ instance/agent/subagent binding)

The architecture doc reasons each binding from one discriminator:

> **Discriminator:** reverse-lookup need **OR** cross-user sharing **OR**
> independent lifecycle ⇒ **table**; none of those ⇒ **array (or pointer)**.

| Binding | Choice | Why |
| --- | --- | --- |
| user ↔ instance | **array** `profiles.allowedInstances` | forward-only, bounded, loaded-with-profile |
| user ↔ agent | **table** `userAgents` | many-to-many, shared across users, per-binding lifecycle, reverse lookup |
| DEFAULT agent | **pointer** `profiles.defaultAgentId` | single-valued by construction ⇒ "exactly one default" unbreakable, no transaction |
| agent ↔ subagents | **array** `agents.subagents` | bounded, always loaded with the agent, never queried alone |
| chat ↔ instance/agent/subagent | **snapshot fields** on `chats` | pin-at-creation; name snapshots survive later unbind/rename |
| provider discriminator | **optional field** `instances.provider` (default `"openclaw"`) | the data-plane provider boundary |

**Options.**
- **B1 (RECOMMENDED) — the discriminator-driven mix above** (new `agents` +
  `userAgents` tables; `allowedInstances` array; `defaultAgentId` pointer;
  `subagents` array; `chats` snapshot fields). Each binding gets the cheapest
  shape its access pattern allows. All additions to EXISTING tables are
  **OPTIONAL** so `convex push` validates current rows; new tables may carry
  required fields (precedent: `auditLog`, `roles`, `serviceAccounts`).
- **B2 — arrays-only on `profiles`, no new tables.** Embed agents + instances +
  subagents as arrays on the profile. **Rejected:** agents are shared across
  users and need reverse lookup ("who uses agent X", group `sharedAgentId`); an
  array per profile can't satisfy cross-user sharing or independent agent
  lifecycle, and "exactly one default" becomes a hand-maintained flag.
- **B3 — fully normalized, every binding a table** (incl. user↔instance,
  agent↔subagent, default-as-boolean-row). **Rejected as over-modeled:**
  forward-only/bounded/loaded-with-profile bindings gain nothing from a table,
  and a `isDefault` boolean row reintroduces the "two defaults" illegal state +
  a serialized single-writer guard that the **pointer** makes unnecessary.

**Recommendation: B1** — adopt the discriminator-driven mix; it is the only
option that satisfies cross-user agent sharing + reverse lookup while keeping the
default unbreakable and the cheap bindings cheap.

> Why this is irreversible: a schema you ship is a migration you own. The
> **DEFAULT-as-pointer** choice in particular makes "two defaults" structurally
> impossible (no single-writer guard needed); reversing it later to a
> `isDefault` boolean reintroduces the illegal state and a serialized writer.

### Decision C — The bridge secret-store location/format

The store is the ONLY place per-instance secrets live (gateway `token`,
`device_identity`, Hermes `api_key`). It generalizes Image #22's shape
per-provider; `groups.<name>` key == `instances.name` (the one non-secret token
that crosses to Convex). `users{}` is preserved **verbatim** but annotated as
**offline bootstrap / fallback only — Convex wins** when both exist.

**Options.**
- **C2 — env vars** (today's `config.ts`). **Rejected at multi-instance:**
  env-only, no reload, a growing JSON-in-env-var leaks into child processes /
  crash dumps. Fine for the single-instance bridge, wrong for many instances.
- **C1 (RECOMMENDED) — mounted secrets file** (`/etc/openclaw-bridge/secrets.json`,
  `0400` root-only) behind a `SecretStore.getGroup(name)` interface.
  Arbitrary-size JSON, off the process env, atomic rotation + `fs.watch`
  hot-reload.
- **C3 — external vault (Vault / cloud KMS).** The production upgrade. Because
  the `SecretStore.getGroup(name)` loader interface is identical whether bytes
  come from a file or a vault fetch, this is a **loader swap, not an architecture
  change** — so adopt C1 now and document C3 as the next step rather than
  building it up front.

**Recommendation: C1** — mounted JSON file now behind the loader interface;
vault (C3) is a drop-in later. Bootstrap-only secrets that cannot live in the
routable store (`BRIDGE_INGEST_SECRET`, `BRIDGE_SHARED_SECRET`) stay in bridge
env.

> Why this is irreversible: it fixes the operational secret-handling and
> deployment surface (K8s `Secret` mount + rotation). The loader interface is
> the hedge that keeps the *format* decision reversible while the *location*
> decision is committed.

**Phase 0 gate:** explicit user confirmation of A, B, C (the `decisions[]`
output). **No file is created until all three are confirmed.**

---

## Phase 1 — Provider abstraction seam (pure refactor, zero behavior change)

> ✅ **DONE (2026-06-04).** Layout established: `core/{events,provider,turn-sink}.ts`
> + `providers/openclaw/{openclaw-client,normalizer,sanitize,session-keys,run-manager}.ts`.
> `RunManager` split into the OpenClaw **driver** (`providers/openclaw/run-manager.ts`,
> Normalizer + TurnSink, same public API) and the provider-agnostic **`TurnSink`**
> (`core/turn-sink.ts`, the `apply()`/finalize sink). The event vocabulary moved to
> `core/events.ts` (re-exported from the normalizer for back-compat). Added
> `bridge/vitest.config.ts` (node env) so `npm test` runs the suites. **Gate met:**
> bridge tsc 0; **31/31 bridge tests byte-green** (23 normalizer + 8 run-manager);
> tsc src+convex 0; root vitest 97; mcp 36; `core/` imports zero OpenClaw code
> (only `events` + `convex-writer`). The OpenClaw `adapter.ts` implementing
> `BridgeProvider` lands in P2.

**Depends on:** nothing (decision-independent). **Lead with this.**

**Scope.** Carve the provider boundary at the **normalized event vocabulary**
(`message.delta | message.snapshot | message.final | run.status | tool.status |
media`) without changing any behavior. Move version/vendor-specific code under a
provider; keep provider-agnostic code in core. This is the "perfectly pluggable"
requirement, delivered as the most-verifiable step.

**Files.**
- **NEW** `bridge/src/core/events.ts` — the `NormalizedEvent` union + `EVENT_*`
  constants **moved out of** `normalizer.ts` so both providers import the *same*
  contract.
- **NEW** `bridge/src/core/provider.ts` — the `BridgeProvider` interface,
  `Routing`, `InstanceSecrets`, `TurnHandle`, `ProviderCapabilities` (verbatim
  from the architecture doc).
- **MOVE UNCHANGED** `openclaw-client.ts`, `normalizer.ts`, `session-keys.ts` →
  `bridge/src/providers/openclaw/` (normalizer now imports events from core).
- **SPLIT** `run-manager.ts`: the **event-consuming half** (`apply()` switch +
  the `message.final`-buffer/paired-`run.status` finalize at
  `run-manager.ts:124-204`) stays in core as the provider-agnostic
  `on(event)` sink; the normalizer-driving half is destined for the adapter (P2).
- **UNCHANGED** `convex-writer.ts` (the durable-persistence seam stays put).

**Gate.**
- `npx tsc -p bridge/tsconfig.json --noEmit` → 0.
- The **23 normalizer tests stay byte-green** (this is the proof of "zero
  behavior change"); `npx vitest run` stays 87; `npm --prefix mcp test` 36.
- **Live-verify:** none required (no runtime change) — but run the existing
  single-instance smoke (`POST /send` → normalizer feed from a fixture frame →
  `ConvexWriter` calls) and confirm identical output to pre-refactor.

---

## Phase 2 — OpenClaw adapter + one-connection-per-INSTANCE multiplexing

**Depends on:** P1. **Highest risk** — the biggest departure from today's
per-chat socket.

**Scope.**
1. **NEW** `bridge/src/providers/openclaw/adapter.ts` implementing
   `BridgeProvider` over the three moved files. `connect(secrets)` validates
   `{token, deviceIdentity}` and opens ONE WS for the instance; `sendMessage`
   builds the sessionKey, applies the per-sessionKey verbose guard, `chat.send`,
   extracts the ack runId (the `extractRunId` logic at `server.ts:96-108` moves
   here), seeds a per-chat normalizer; `abort` = local force-finalize
   (`endTurn(now,"aborted")`) since **there is no `chat.abort` RPC in the repo
   (NOT FOUND)**; `getHistory`/`listConversations` route through `conn.request`
   with **honest `capabilities()`** (shapes unverified — see open decisions).
2. **NEW** `bridge/src/core/registry.ts` — connection registry **keyed by
   instance** (the Image #22 "group" = one gateway instance + its secrets), not
   by chat. The dedup-by-inflight pattern from `session.ts:157-176` generalizes
   from per-chat to per-instance.
3. **Multiplex fan-out:** the adapter owns `Map<sessionKey, ChatTurnState>` and
   routes each inbound frame to the right per-chat normalizer by
   `payload.sessionKey`. The isolation gate at `normalizer.ts:360-374`
   (sessionKey match + foreign-run drop) **stays byte-exact** — it doubles as
   per-user isolation.
4. **Consume loop generalizes:** today `session.ts:66-103` races one frame-read
   against one normalizer's `nextTimeout`; the adapter races the single
   frame-read against the **min `nextTimeout` across all active normalizers**,
   ticks whichever deadline expired, recomputes the min. Preserve the
   single-pending-read invariant (`session.ts:67-73`) so no frame is lost on a
   tick boundary.

**Latent bug to FIX (not copy forward).** `verboseFullApplied` is a
**per-connection boolean** (`openclaw-client.ts:129`, set at `server.ts:119-125`)
— correct only when one connection serves one session. Under one-connection-many-
sessions it must become a **per-sessionKey `Set<string>`**, or chat A's
`sessions.patch` suppresses chat B's. The adapter patches `verboseLevel=full`
**once per sessionKey**.

**Files.** NEW `providers/openclaw/adapter.ts`, NEW `core/registry.ts`;
**rewrite** `session.ts` consume loop into the adapter (the `SessionRegistry`
chatId-keyed map is replaced by the instance-keyed registry); **fix**
`verboseFullApplied` boolean → per-sessionKey Set.

**Gate.**
- `npx tsc -p bridge/tsconfig.json --noEmit` → 0; 23 normalizer tests green.
- **NEW unit tests:** (a) two interleaved sessionKeys on one socket fan out to
  two normalizers with no cross-talk; (b) a frame for a foreign runId is dropped;
  (c) min-deadline tick finalizes only the expired chat; (d) per-sessionKey
  verbose guard patches each sessionKey exactly once.
- **Live-verify (single-instance, unchanged behavior):** with the existing
  single OpenClaw instance, a real send still streams to the browser identically
  — multiplexing is invisible when there is one session. Then a **two-chat
  concurrent** live send shows independent streams.

---

## Phase 3 — Convex schema deltas (routing metadata only)

**Depends on:** P0-B confirmed.

**Scope.** Add the non-secret routing metadata. All EXISTING-table deltas
OPTIONAL.
- `instances`: `provider?: "openclaw"|"hermes"` (absent ⇒ openclaw),
  `publicUrl?`.
- **NEW** `agents` table (`instanceName`, `agentId`, `displayName?`, `provider?`,
  `subagents?: [{subagentId, name?}]`) + indexes `by_instance`,
  `by_instance_agent`.
- **NEW** `userAgents` join table (`userId`, `agentId`) + indexes `by_user`,
  `by_agent`, `by_user_agent`.
- `profiles`: `defaultAgentId?: v.id("agents")`, `allowedInstances?: string[]`.
- `chats`: `instanceName?`, `agentId?`, `subagentId?` (snapshots, pinned at
  creation so a later unbind/rename never orphans the chat).

**Files.** `convex/schema.ts` (+ generated `_generated/*`); thin
admin/query helpers for the new tables compose existing bricks
(`chat/admin/DataTableShell`, `EntitySheet`).

**Gate.**
- `npx tsc -p convex/tsconfig.json --noEmit` → 0; `npx vitest run` green.
- **Live-verify:** `convex push` against the local deployment **validates all
  pre-existing rows** (the OPTIONAL discipline) — a deploy that rejects existing
  rows is a failed gate. Insert one `agents` + one `userAgents` row via a
  dev-gated mutation and read them back.

---

## Phase 4 — Provider selection + agent/instance resolution + outbound wiring

**Depends on:** P2, P3.

**Scope.**
1. **Resolution** (Convex `convex/bridge.ts` dispatch + `lib/access`-style
   resolver): default agent = exactly one `userAgents` binding implicitly, else
   `profiles.defaultAgentId` (validated to point at a real binding, fallback
   "first binding" if dangling); instance from the chat snapshot, else the
   per-new-chat picker choice. Emit `provider` + non-secret routing on the
   `POST /send` payload.
2. **Per-new-chat instance picker:** when `allowedInstances.length > 1`, chat
   creation MUST prompt for the instance and snapshot it onto the chat; length 1
   (or group fallback) auto-selects.
3. **Bridge side:** `registry.acquire(instanceKey, provider)` instantiates the
   matching adapter; `performSend` (`server.ts:116-141`) is rewritten to call
   `provider.sendMessage(...)` then core `RunManager.beginTurn(handle.runId)` —
   **preserving the "create the streaming message up-front" guarantee**.
4. The entire outbound dedup path (`send.sendMessage` → `outbox` → scheduled
   `bridge.dispatch`) is **unchanged**.

**Files.** `convex/bridge.ts` (routing payload + provider), `convex/send.ts`
(unchanged path; verify), `convex/chats.ts` (snapshot picker choice at
creation), `bridge/src/core/server.ts` (`performSend` → `provider.sendMessage`),
`bridge/src/core/registry.ts` (provider-keyed acquire). Frontend: new-chat
instance picker composing existing dialog bricks.

**Gate.**
- All four tsc targets → 0; `npx vitest run` green (add resolution tests:
  single-binding-implicit-default, multi-binding-pointer-default,
  dangling-pointer-fallback, `allowedInstances>1` forces picker).
- **Live-verify:** a user with 2 instances → new chat shows the picker → the
  choice is snapshotted on the chat → send routes to the chosen instance; a user
  with 2 agents and a `defaultAgentId` → send uses the default.

---

## Phase 5 — Multi-instance secret store

**Depends on:** P0-C confirmed (independent of P4; can land in parallel after
P2).

**Scope.** Replace the env-only single-instance secret loading with the
`SecretStore` abstraction backed by a mounted JSON file (Decision C).
- **NEW** `bridge/src/core/secret-store.ts` — `SecretStore.getGroup(name)`
  returns `{provider, url, token?, device_identity?, api_key?, verbose,
  public_url}` per instance; file loader with `0400` enforcement + `fs.watch`
  atomic-rotation hot-reload; `users{}` fallback honored only when a send arrives
  without Convex-resolved routing (detached/dev).
- `config.ts` keeps ONLY bootstrap secrets (`BRIDGE_INGEST_SECRET`,
  `BRIDGE_SHARED_SECRET`, `CONVEX_HTTP_ACTIONS_URL`, port); the per-instance
  `token`/`device_identity`/`api_key` move OUT of env into the store.
- `registry.acquire(instanceKey)` reads secrets via `SecretStore.getGroup` and
  passes `InstanceSecrets` to `provider.connect`.

**Files.** NEW `core/secret-store.ts`; **rewrite** `config.ts` (drop per-instance
secrets); `core/registry.ts` wires the store into `connect`.

**Gate.**
- `npx tsc -p bridge/tsconfig.json --noEmit` → 0; NEW tests: load a 2-instance
  file, `getGroup` returns each shape; a malformed/missing file fails fast;
  hot-reload picks up a rotated token; `users{}` fallback used only when routing
  absent.
- **Invariant check (loud):** grep the bridge → Convex egress confirms NO
  `token`/`device_identity`/`api_key` value ever appears in an ingest payload or
  a Convex write. **Live-verify:** two instances in the file → connect to both;
  rotate one instance's token in the file → next connect uses the new token with
  no restart.

---

## Phase 6 — Hermes adapter (structural skeleton, no invented frames)

**Depends on:** P1, P5. **Pin a tested Hermes version before relying on exact
field names** (research flags Hermes surface stability as a live gap).

**Scope.** Prove pluggability with a second provider that mirrors the OpenClaw
adapter exactly: one connection per instance, a per-chat `HermesNormalizer`
emitting the **same six** `core/events.ts` events, the same
`Map<sessionKey, ChatTurnState>` multiplexing. Hermes is HTTP/SSE +
single-key auth, so multi-tenancy is enforced by the bridge (user → `session_id`
/ `X-Hermes-Session-*`), mirroring the per-instance secret model.
**Do NOT invent Hermes runs-events strings** — that vocabulary is NOT FOUND in
docs/source (research gap). Map only the confirmed surfaces (chat-completions /
responses SSE, `/api/sessions/*` for list/history). Any Hermes-only concept
(e.g. structured reasoning) is an **additive optional** normalized-event /
messagePart variant — never a breaking change to the six (core `apply()` already
no-ops unknown event types at `run-manager.ts:181-184`).

**Files.** NEW `providers/hermes/{hermes-client.ts, hermes-normalizer.ts,
adapter.ts}`; `core/registry.ts` provider map gains `hermes`.

**Gate.**
- `npx tsc -p bridge/tsconfig.json --noEmit` → 0; OpenClaw path tests still
  green (proves the additive-only discipline didn't break the six).
- `capabilities()` for Hermes states divergence honestly (e.g.
  `streaming:"delta"`, `subagents:false` if no subagent model).
- **Live-verify (if a Hermes instance is available):** a user routed to a Hermes
  instance streams token-by-token via the same browser path; otherwise gate on
  the SSE→normalized mapping unit tests against recorded Hermes fixtures.

---

## Phase 7 — Streaming decoupling implementation

**Depends on:** P0-A confirmed, P1 (behind the `ConvexWriter` seam).

**Scope.** Implement the chosen Decision A pattern: persist live streaming text
into a dedicated lightweight, **un-indexed** live field/row that `useQuery`
subscribes to (coarse flush), reconcile into the durable, searchable
`messages.text` once at finalize. Removes the O(n²) rewrite + reindex-per-flush
amplifiers while keeping Convex the sole browser transport (no SSE-per-turn).
The change lives **behind `RunManager → ConvexWriter`**; `BridgeProvider` is
untouched.

**Files.** `convex/stream.ts` (live field write + finalize reconcile),
`convex/schema.ts` (live text field/row — OPTIONAL), `convex/messages.ts`
(read path subscribes to the live field during streaming), frontend thread
read; `bridge/src/core/convex-writer.ts` flush target. Search index on
`messages.text` is written **once at finalize**, not per flush.

**Gate.**
- All tsc targets → 0; `npx vitest run` green (add: live field updates without
  reindex; finalize reconciles into searchable `text`; reconnect mid-stream
  resumes from the live field).
- **Live-verify:** token-by-token fluidity is visibly smooth under a long turn;
  a mid-stream browser refresh resumes the live text; full-text search finds the
  message only after finalize; OpenClaw keeps emitting after the turn boundary
  with no closed-socket failure (the Image #23 premise holds).

---

## Cross-cutting: progressive UI (incremental, after P3/P4)

Not a single phase — each affordance is gated on
`capabilities()` for the connected user's provider: abort button
(`capabilities.abort`), history pane (`history`), conversation picker
(`listConversations`), attachment upload (`attachments`), in-flight tool status
(always, from `tool.status`), instance/agent/subagent pickers (from the P3 data
model). Build these as they become useful; the architecture is already shaped to
surface them.

---

## Open items the build must resolve (carried from research, honestly)

These are NOT FOUND / unverified in the repo+docs and must be confirmed against
primary source before the dependent phase relies on them — never fabricated:
- OpenClaw `chat.history` / conversation-list **param + response shapes**
  (referenced only in comments; `capabilities()` reports them honestly until
  verified). → P2.
- OpenClaw `abort` RPC existence (currently synthesized via socket-close→finalize).
  → P2.
- Hermes `/v1/runs/{id}/events` SSE event-type strings (NOT FOUND). → P6.
- Hermes version pin for stable field names. → P6.
- Webchat sessionKey segment grammar beyond the fixture-confirmed form
  (`session-keys.ts` + fixtures are authoritative). → P2.