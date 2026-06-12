# Bridge Architecture — Modular, Multi-Provider, Multi-Tenant

**Status:** design only (no implementation). **Pinned provider version:** OpenClaw
`v2026.5.19`. Multi-version support is out of scope.

This document evolves the existing single-instance OpenClaw bridge (`bridge/src/*`)
into a modular, multi-provider (OpenClaw now, Hermes later), multi-tenant bridge,
while preserving the proven core (the 737-line `normalizer.ts`, the `ConvexWriter`
seam, the outbox dispatch path).

It incorporates the red-team fixes. Where a fact is not in the repo and not
web-verifiable for `v2026.5.19`, it is marked **NOT FOUND** rather than invented —
a fabricated provider surface is the worst possible outcome.

---

## 1. Overview + the Convex transport (4-box diagram)

The bridge is a **headless** Node/TS worker. Convex is the reactive
DB/auth/storage/scheduler; it **cannot hold a long-lived operator WebSocket**, so
the bridge owns that socket. The frontend renders off a reactive Convex `useQuery`
(assistant-ui `ExternalStoreRuntime`), never per-turn HTTP/SSE.

```
┌──────────────┐   1. send (mutation)          ┌──────────────────────────────┐
│   BROWSER    │ ───────────────────────────►  │            CONVEX            │
│ assistant-ui │                                │  reactive DB · auth · file   │
│ ExternalStore│   2. useQuery(messages,parts)  │  storage · scheduler · ingest│
│   Runtime    │ ◄═══════════ reactive ═══════  │                              │
│              │                                │  outbox → bridge.dispatch    │
│  4b. live    │                                │  /bridge/ingest (httpAction) │
│  delta WS    │◄─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─┐         └──────────┬──────────────▲───┘
└──────────────┘   (ephemeral, see §4)│      3. POST /send │   5. POST     │
                                      │       (dispatch)   ▼   /bridge/ingest
                                ┌─────┴──────────────────────────────────────┐
                                │                 BRIDGE (headless Node)      │
                                │  core: registry · RunManager · ConvexWriter │
                                │  providers/openclaw · providers/hermes      │
                                │  SECRET STORE (tokens, device identities)   │
                                │  4a. live-delta fan-out hub (ephemeral)     │
                                └─────┬───────────────────────────────────────┘
                                      │ 6. ONE persistent operator WS per INSTANCE
                                      ▼
                                ┌──────────────────────────────────────────────┐
                                │   PROVIDER GATEWAYS (instances)              │
                                │   OpenClaw gateway(s) · Hermes endpoint(s)   │
                                └──────────────────────────────────────────────┘
```

**The four boxes and the flows between them**

1. **Browser → Convex (send).** The user's turn is a Convex `mutation`
   (`send.sendMessage`): it writes the optimistic user `message`, an `outbox` row
   (idempotent on `(userId, clientMessageId)`), and schedules `bridge.dispatch`.
   No secret leaves Convex; the browser never talks to a gateway.
2. **Convex → Browser (durable reactivity).** The browser subscribes to
   `messages` + `messageParts` via `useQuery`. Every persisted normalized event
   re-renders assistant-ui. This is the **durable / reconnect / history** channel.
3. **Convex → Bridge (`POST /send`).** `bridge.dispatch` POSTs the pending turn to
   the bridge with `Authorization: <BRIDGE_SHARED_SECRET>` (raw, no `Bearer`) and a
   body of **non-secret routing metadata only** (`chatId`, provider chat id, text,
   `clientMessageId`, attachments, and — new — the resolved `provider` +
   `instanceName` + `agentId` + `canonical`).
4. **Bridge → Browser live tokens (ephemeral, §4).** Token-by-token deltas are
   fanned out over a **persistent** bridge→browser channel that does **not** go
   through `messages.text`, so per-frame fluidity is not bounded by a Convex
   round-trip. Convex remains authoritative on `finalize`. This is the explicit
   decoupling the hard requirement demands (§4).
5. **Bridge → Convex (`POST /bridge/ingest`).** Normalized events are persisted via
   the authenticated ingest `httpAction` (`Bearer BRIDGE_INGEST_SECRET`), which runs
   the `internal.stream.*` mutations. This is the **durability** half of §4.
6. **Bridge → Gateways.** **One persistent operator WebSocket per *instance*** (not
   per chat), multiplexing every chat and every user routed to that instance.

**Why this shape (migration premise).** Persistence + reactivity live in Convex.
There is **no SSE-per-turn that closes**, so a provider can keep emitting after the
turn boundary — this is precisely the fix for the Open WebUI pipe failure mode. The
§4 live channel is **persistent**, not per-turn, so it does *not* reintroduce that
failure.

---

## 2. Provider abstraction layer

### 2.1 The seam: the normalized event stream

The provider boundary is the **normalized event vocabulary**, not raw gateway
frames:

```
message.delta(text)        — append text to the streaming reply
message.snapshot(text)     — replace the streaming reply with text
message.final(text,error?) — the turn's authoritative final text
run.status(status,runId)   — started|running|working|compacting|final|error|aborted
tool.status(name,phase,runId)
media(items[],runId)       — inbound files
```

Everything **version- and vendor-specific** (the WS handshake, the frame
transducer, session-key grammar, dedup/grace state machines, *and the consume-loop
timing machinery*) lives **inside a provider**. Everything **provider-agnostic**
(turn lifecycle into Convex, the `ConvexWriter` seam, the outbound send/outbox path,
media-byte upload) lives in **core**.

This forces one structural split that the obvious "wrap the WebSocket" layout gets
wrong: the current single `RunManager` is **split in two**:

- Its **normalizer-driving** half (`beginTurn`/`feed`/`tick`/`nextTimeout`,
  `ownRunIds` seeding, the consume loop currently in `session.ts:66-103`) moves
  **into the OpenClaw adapter** — it is OpenClaw-frame-specific.
- Its **event-consuming** half (the `apply()` switch and the `message.final`-buffer
  + paired-`run.status` finalize logic at `run-manager.ts:124-204`) **stays in
  core** as the provider-agnostic sink.

`openclaw-client.ts`, `normalizer.ts`, and `session-keys.ts` move under
`providers/openclaw/` **unchanged** — that is the minimal-change win.

### 2.2 The `BridgeProvider` interface

```ts
// core/provider.ts — the abstraction boundary. Both adapters implement this.
import type { NormalizedEvent } from "./events.js";

/** Non-secret routing for one turn/connection. Mirrors Convex routing metadata. */
export interface Routing {
  /** Convex chat id (durable identity core uses to address the RunManager). */
  chatId: string;
  /** Provider-side conversation/session id (was `openclawChatId`). */
  providerChatId: string | null;
  /** Per-user agent selection (default agent already resolved by core). */
  agentId: string | null;
  /** Operator/canonical segment (per-user). */
  canonical: string | null;
  /**
   * Optional subagent target. Pluggable but NOT wired for OpenClaw yet — the
   * subagent session-key grammar is NOT FOUND for v2026.5.19 (see §2.4).
   */
  subagentId?: string | null;
}

/** Opaque per-instance secrets, read from the BRIDGE secret store — never Convex. */
export interface InstanceSecrets {
  readonly [k: string]: unknown; // provider validates the shape it needs
}

/** Handle from sendMessage so core can create the streaming message up-front. */
export interface TurnHandle {
  runId: string | null; // provider ack runId, or null if none yet
}

export interface ProviderCapabilities {
  abort: boolean;            // a real server-side abort RPC (vs local finalize)
  history: boolean;          // getHistory backed by a real call
  listConversations: boolean;
  attachments: boolean;      // accepts outbound attachments on sendMessage
  media: boolean;            // emits `media` events for inbound files
  subagents: boolean;        // honours Routing.subagentId
  streaming: "delta" | "snapshot" | "both";
}

export interface BridgeProvider {
  readonly kind: "openclaw" | "hermes";

  /** Open ONE long-lived connection for the instance. Idempotent per instance. */
  connect(secrets: InstanceSecrets): Promise<void>;

  /** Send a user turn. Returns the ack runId so core can begin the turn. */
  sendMessage(
    routing: Routing,
    text: string,
    clientMessageId: string,
    attachments?: unknown[],
  ): Promise<TurnHandle>;

  /** Stop an in-flight turn for one chat (server RPC if capable, else finalize). */
  abort(routing: Routing): Promise<void>;

  /** Past messages for a conversation (provider call; shape provider-specific). */
  getHistory(routing: Routing, opts?: { limit?: number }): Promise<unknown>;

  /** Provider-side conversation list for the connected user/instance. */
  listConversations(opts?: { limit?: number }): Promise<unknown>;

  /** Subscribe to normalized events; the event carries chat identity. */
  on(handler: (chatId: string, event: NormalizedEvent) => void): void;

  capabilities(): ProviderCapabilities;

  /** Close the connection and finalize any in-flight turns as aborted. */
  close(): Promise<void>;
}
```

**The guaranteed seam is exactly this method surface plus the six normalized
events.** Nothing else (consume-loop timing, `Map<sessionKey, ChatTurnState>`,
`nextTimeout`/`tick`) is part of the contract — those are OpenClaw implementation
details (fix #6).

**One change to the event itself.** Today there is *one normalizer per chat*, so
emitted events carry no chat identity (it is implicit). Under one-connection-per-
instance, events from many chats interleave on one socket, so `on()` delivers
`(chatId, event)`. The `EVENT_*` constants and the `NormalizedEvent` union move out
of `normalizer.ts` (an OpenClaw file) into **`core/events.ts`** so both providers
import the *same* contract.

### 2.3 One connection per INSTANCE, fan-out per session

This is the highest-risk departure from today's code, where `SessionRegistry`
(`session.ts:147-199`) opens one WebSocket per `chatId`.

1. **The connection registry is keyed by instance** (the Image #22 "group" — a
   routing target backed by one gateway instance + its secrets), not by chat.
   Multiple chats and multiple users (the secret-store `users[]` that all map to one
   instance) multiplex over the single socket. `groups.mode: per-user | shared`
   affects **sessionKey / agentId derivation only** — it must NOT cause per-user
   sockets.
2. **The normalizer stays per-chat.** It holds per-turn text, `ownRunIds`, and
   absolute deadlines (`normalizer.ts:215-251`) — inherently per-conversation. The
   OpenClaw adapter owns a `Map<sessionKey, ChatTurnState>` per connection
   (`ChatTurnState = { normalizer, chatId, ... }`) and **fans each inbound frame to
   the right normalizer by `payload.sessionKey`**. The isolation gate at
   `normalizer.ts:361` (`payload.sessionKey !== this.sessionKey` → drop) is exactly
   what makes the multiplexing safe; it doubles as per-user isolation and must stay
   **byte-exact**. A frame whose `sessionKey` matches no active turn is dropped.
3. **The consume loop generalizes.** Today `session.ts:66-103` races one frame-read
   against a single normalizer's `nextTimeout`. The adapter's loop races the single
   frame-read against the **minimum `nextTimeout` across all active normalizers on
   the connection**, and on a timeout `tick()`s whichever normalizer's deadline
   expired (finalizing it), then recomputes the min. The single-pending-read
   invariant (`session.ts:67-73`) is preserved, so no frame is lost on a tick
   boundary. **This machinery is OpenClaw-only (fix #6).**

### 2.4 OpenClaw adapter (minimal change)

```
bridge/src/providers/openclaw/
  openclaw-client.ts   # UNCHANGED — WS handshake, Ed25519 signChallenge, request/frames
  normalizer.ts        # UNCHANGED — the proven 737-line transducer (imports events from core)
  session-keys.ts      # UNCHANGED — agent:<agentId>:webchat:chat:<canonical>:<chatId>
  adapter.ts           # NEW — implements BridgeProvider over the three above
```

`adapter.ts` is the only genuinely new OpenClaw code:

- **`connect(secrets)`** — validates `{ token, deviceIdentity }` from the instance
  secret store, calls `OpenClawConnection.connect(gatewayUrl, token, deviceIdentity)`
  (`openclaw-client.ts:136`), starts the multiplexed consume loop.
  `capabilities()` returns:
  ```
  { abort:false, history:false, listConversations:false,
    attachments:true, media:true, subagents:false, streaming:"both" }
  ```
- **`sendMessage(...)`** — builds the sessionKey via
  `buildSessionKey(providerChatId ?? chatId, agentId ?? "main", canonical)`
  (`session-keys.ts:23`); applies the **per-sessionKey `verboseLevel=full` guard**
  (fix #7, below); `conn.request("chat.send", { sessionKey, message, idempotencyKey,
  attachments? })`; extracts the ack runId (`server.ts:96-108` logic moves here);
  creates and seeds the per-chat `Normalizer` (`beginTurn` + `noteRunStarted`),
  registers it in the connection's `Map<sessionKey, ChatTurnState>`; returns
  `{ runId }`.
- The consume loop drives `normalizer.feed/tick`; each emitted event is forwarded
  through `on()` as `(chatTurnState.chatId, event)`.
- **`abort(routing)`** — there is **no `chat.abort` RPC in the repo (NOT FOUND)**.
  Today abort is synthesized via socket-close → finalize-as-aborted
  (`session.ts:79-86`). The adapter models `abort` as a **local force-finalize** of
  that chat's normalizer (`endTurn(now, "aborted")`) emitted through `on()`. If a
  real abort RPC is later confirmed for `v2026.5.19`, it slots in here without an
  interface change. `capabilities().abort` stays `false` until then.
- **`getHistory` / `listConversations`** — `chat.history` appears only in code
  comments; a conversation-list call is **not in the repo (NOT FOUND)**. They route
  through the existing `conn.request(...)` correlation mechanism, but the
  **param/response shapes are unverified**, so `capabilities()` reports both `false`.

**Fix #7 — `verboseFullApplied` must become per-sessionKey.** Today
`verboseFullApplied` is a single per-connection boolean (`openclaw-client.ts:129`),
and `performSend` patches `sessions.patch` once per connection (`server.ts:119-126`).
That is correct only because today one connection serves one session. Under
one-connection-many-sessions, a per-connection boolean lets chat A's
`sessions.patch` suppress chat B's patch (`sessions.patch` takes a per-session
`key`, `server.ts:119-126`). The adapter therefore tracks a **per-sessionKey
`Set<string>` on the connection** and patches `verboseLevel=full` **once per
sessionKey**, not once per socket.

### 2.5 Hermes adapter (structural skeleton only)

```
bridge/src/providers/hermes/
  hermes-client.ts     # NEW — Hermes transport (its own auth + request/stream)
  hermes-normalizer.ts # NEW — Hermes frames -> the SAME six normalized events
  adapter.ts           # NEW — implements the SAME BridgeProvider method surface
```

Hermes is **structural only**. Its API is **NOT FOUND** in the repo, so **no Hermes
frame shapes, transport model, or auth flow are invented here** (fix #6).

What is guaranteed: Hermes implements the **`BridgeProvider` method surface** and
emits the **six `core/events.ts` normalized events**. That is the entire contract.

What is **not** assumed: Hermes does **not** necessarily reuse the OpenClaw consume
loop, the `min(nextTimeout)` deadline-ticking, or the `Map<sessionKey,
ChatTurnState>` multiplexing. Hermes' transport may be request/response, SSE, or a
persistent socket — **NOT FOUND** — so its adapter internals are **TBD** and are an
implementation detail of `providers/hermes/`, never a contract OpenClaw and Hermes
must share. Its `capabilities()` states its real divergence honestly (e.g.
`streaming:"delta"` if it only does token deltas, `subagents:false`).

**Additive extensions.** If a Hermes mapping surfaces a concept OpenClaw lacks (a
structured `reasoning` part — already in `convex-writer.ts:25-29` and
`schema.ts:45-48` — or a new tool phase), it is added as a **new optional**
normalized-event variant or messagePart kind, never a breaking change to the six.
Core's `apply()` switch already has a `default:` no-op (`run-manager.ts:181-184`), so
an additive event never breaks the OpenClaw path.

### 2.6 Provider selection (per connected user) + core layout

```
bridge/src/core/
  events.ts            # NEW — NormalizedEvent union + EVENT_* constants (moved out of normalizer)
  provider.ts          # NEW — BridgeProvider interface (§2.2)
  run-manager.ts       # MOVED + SLIMMED — event -> ConvexWriter only (apply() + finalize buffer)
  registry.ts          # NEW — Map<instanceKey, BridgeProvider>; lazy connect/reuse/reconnect
  convex-writer.ts     # CHANGED — addMedia is rewritten (§4.4 / fix #1); rest of the seam intact
  config.ts            # MOVED — bridge env + secret-store loader (multi-instance, §3)
  server.ts            # MOVED + THIN — POST /send resolves provider, calls sendMessage, begins turn
  live-hub.ts          # NEW — ephemeral bridge->browser live-delta fan-out (§4)
  index.ts             # MOVED — wiring
```

- **Provider discrimination** reads an **optional** Convex field `provider?:
  "openclaw" | "hermes"` on the **instance** (defaulting to `"openclaw"` when
  absent, so `convex push` validates existing rows). Core reads it from the
  non-secret routing metadata Convex sends on `POST /send`.
- **Per-user selection flow.** On a send, core resolves the user's routing (default
  agent already chosen per the multi-agent rule; "which instance" already resolved at
  chat creation, §3.5), reads `provider`, and calls
  `registry.acquire(instanceKey, provider)`. The registry lazily instantiates the
  matching adapter, calls `connect(secretsForInstance)` once, reuses it for every
  subsequent chat/user on that instance, and reconnects on close (the
  dedup-by-inflight pattern from `session.ts:157-176` generalizes from per-chat to
  per-instance).
- **Secret boundary (loud invariant).** `connect(secrets)` pulls secrets **only**
  from the bridge's own secret store keyed by instance (§3.6). Convex carries
  non-secret routing metadata only. No gateway token, device identity, or API key
  ever touches a Convex table or the browser.
- The **entire outbound path** (`send.sendMessage` dedup → `outbox` → scheduled
  `bridge.dispatch` → `POST /send`) is unchanged; only `performSend`
  (`server.ts:116-141`) is rewritten to call `provider.sendMessage(...)` then core
  `RunManager.beginTurn(handle.runId)`, preserving today's "create the streaming
  Convex message up-front, before any content frame arrives" guarantee
  (`run-manager.ts:92-94`).

`capabilities()` is the signal the "progressively surface everything" UI keys off
(§5) and where OpenClaw-vs-Hermes feature divergence is stated honestly.

---

## 3. Multi-tenant data model + bridge secret store

The hard rule throughout: **Convex stores non-secret routing metadata and is the
single source of truth for it; the bridge secret store holds the secrets and never
leaks them to Convex or the browser.** All deltas to **existing** tables are
**OPTIONAL** so `convex push` validates pre-existing rows. New tables may carry
required fields (precedent: `auditLog`, `roles`, `serviceAccounts`).

### 3.0 Two naming collisions resolved first

**Collision A — Image #22 `groups{}` is NOT the Convex `groups` table.** An Image
#22 "group" is *a routing target backed by ONE gateway instance + its secrets*
(`url`, `token`, `device_identity`, `verbose`, `public_url`). That is the existing
Convex **`instances`** table on the non-secret plane plus per-instance secret
material on the bridge plane:

| Image #22 `groups.<name>` field | Plane | Lands in |
| --- | --- | --- |
| `<name>` (key) | non-secret | `instances.name` (join key across both planes) |
| `url` | non-secret | `instances.gatewayUrl` **and** bridge secret `url` |
| `public_url` | non-secret | `instances.publicUrl` (NEW optional) |
| `token` | **SECRET** | bridge secret store ONLY |
| `device_identity` | **SECRET** | bridge secret store ONLY |
| `verbose` | operational | bridge secret store ONLY (runtime flag) |

The Convex **`groups`** table keeps its **existing, different** meaning: a
membership/valve cohort (`name`, `instanceName`, `mode: per-user|shared`,
`sharedAgentId`, `schema.ts:119-125`) binding users to one instance with a
shared-vs-isolated agent policy. Its semantics are **not touched**.

**Collision B — Image #22 `users{group, agent_id, canonical}` is non-secret, so by
the invariant it belongs in Convex, not the bridge.** Convex (`profiles` + the join
tables below) is **authoritative** for user → instance / agent / subagent. The
bridge's `users{}` map is preserved verbatim (the task requires the format) but is
annotated **OFFLINE BOOTSTRAP / FALLBACK only** — consulted only when a send arrives
without Convex-resolved routing (detached/dev/disaster-recovery). **When both exist,
Convex wins.** Exactly one source of truth for live routing.

### 3.1 Agent resolution — ONE resolver, extended (fix #3)

`routing.ts` is and remains the **single** resolver. There is **no second
resolution path.** Today (`routing.ts:30-72`) precedence is:

```
1. override:        profile.overrideInstance (+ overrideAgentId)
2. group-per-user:  group.instanceName, agentId = canonical
3. group-shared:    group.instanceName, agentId = group.sharedAgentId
4. unrouted:        null
```

The multi-agent requirement ("1+ agents, exactly one DEFAULT") is layered **above**
override as the new highest-precedence rule, inside the same function — it does
**not** fork:

```
0. default-agent:   profiles.defaultAgentId -> agents row (instance + agentId)   [NEW, top]
1. override:        profile.overrideInstance (+ overrideAgentId)                 [retained]
2. group-per-user:  group.instanceName, agentId = canonical                      [retained]
3. group-shared:    group.instanceName, agentId = group.sharedAgentId            [retained]
4. unrouted:        null                                                         [retained]
```

`ResolvedTarget` still emits **`agentId` as a string segment** (`routing.ts:23-28`) —
the new `agents` table is a *lookup source* feeding step 0, never a competing
representation that crosses to the bridge. `groups.mode` and `profiles.overrideAgentId`
are **retained, not deprecated** (steps 1-3 still serve users with no `userAgents`
binding — i.e. every current row). Resolution rule for the new layer: if the user
has exactly one `userAgents` binding it is the default implicitly; if multiple,
`profiles.defaultAgentId` must point at one of them (validated at write time,
falling back to "first binding" if dangling).

**`provider` is authoritative on `instances` ONLY** (fix #3): an `agents` row inherits
`provider` via its `instanceName` → `instances.provider`. It is **not** duplicated on
`agents`, so the two cannot drift.

### 3.2 `instances` — provider discriminator + public URL (OPTIONAL deltas)

```ts
instances: defineTable({
  name: v.string(),
  gatewayUrl: v.string(),
  displayName: v.optional(v.string()),
  // NEW (optional -> existing rows validate; absent => "openclaw"):
  provider: v.optional(v.union(v.literal("openclaw"), v.literal("hermes"))),
  publicUrl: v.optional(v.string()),   // Image #22 public_url (non-secret topology)
}).index("by_name", ["name"]),
```

`provider` defaults to `"openclaw"` (back-compat with all current rows) and is the
**provider abstraction boundary on the data plane**.

### 3.3 `agents` — NEW table (justified: shared + lifecycle + subagent owner)

```ts
agents: defineTable({
  instanceName: v.string(),          // -> instances.name (an agent lives on one instance)
  agentId: v.string(),               // the agent id segment (e.g. "main")
  displayName: v.optional(v.string()),
  // provider is NOT stored here — inherited via instanceName (fix #3, no drift).
  // Subagents: ARRAY (bounded, always loaded with the agent, never queried alone).
  // The id + label are stored; the session-key grammar to USE them is NOT FOUND (§3.5).
  subagents: v.optional(
    v.array(v.object({ subagentId: v.string(), name: v.optional(v.string()) })),
  ),
})
  .index("by_instance", ["instanceName"])
  .index("by_instance_agent", ["instanceName", "agentId"]),
```

### 3.4 `userAgents` join + `profiles.defaultAgentId` pointer

User ↔ agent is many-to-many, shared across users, with a per-binding lifecycle and
a real reverse-lookup need ("who uses agent X") → a **join table**:

```ts
userAgents: defineTable({
  userId: v.id("users"),
  agentId: v.id("agents"),
})
  .index("by_user", ["userId"])
  .index("by_agent", ["agentId"])             // reverse: who uses this agent
  .index("by_user_agent", ["userId", "agentId"]),
```

The DEFAULT agent is a **single pointer field on `profiles`**, not a boolean-per-
binding — a pointer is single-valued by construction, so "exactly one default"
**cannot** be violated and needs no transaction/single-writer guard:

```ts
// add to EXISTING profiles (optional -> existing rows validate):
defaultAgentId: v.optional(v.id("agents")),
```

### 3.5 user ↔ instance (array) + chat binding (snapshots)

A user may be linked to 1+ instances; if multiple, **each new chat must ask which
instance**. This binding is forward-only, bounded, and always loaded with the
profile → **array, not table**:

```ts
// add to EXISTING profiles (optional):
allowedInstances: v.optional(v.array(v.string())),  // -> instances.name[]
```

This generalizes the existing single `overrideInstance`: `overrideInstance` stays as
the per-user pin (a resolution input); `allowedInstances` is the **menu** the
new-chat picker offers. When `allowedInstances.length > 1`, the UI MUST present the
instance picker at chat creation; length ≤ 1 auto-selects (falling back to the
group's instance).

The picker choice is **snapshotted onto the chat at creation** so a chat stays
pinned even if the user's bindings later change:

```ts
// add to EXISTING chats (all optional):
instanceName: v.optional(v.string()),  // snapshot -> instances.name
agentId:      v.optional(v.string()),  // snapshot -> agent id segment
subagentId:   v.optional(v.string()),  // snapshot -> a subagent id (see NOT FOUND below)
```

These are **name snapshots** (matching `openclawChatId`'s existing pattern), not
foreign keys, so a later unbind/rename never orphans the chat.

**Subagent session-key grammar — NOT FOUND (fix #2).** `session-keys.ts:1-33`
implements **exactly one** grammar — `agent:<agentId>:webchat:chat:<canonical>:<chatId>`
— described as a "faithful port of backend/app/session_keys.py". There is **no
subagent grammar** anywhere in `bridge/src` or the fixtures, and none is
web-verifiable for `v2026.5.19`. Therefore the subagent **concept stays pluggable**
(optional `Routing.subagentId`, optional `chats.subagentId`, `agents.subagents[]`,
`capabilities.subagents`) but the **OpenClaw adapter MUST NOT build a subagent key
from an unverified template**, and `capabilities.subagents` is **`false` for OpenClaw**
until the grammar is confirmed from a primary source. When confirmed, only
`session-keys.ts` + the capability flag change.

### 3.5.1 Picker read-boundary — non-admin projection (fix #4)

The new-chat instance picker runs as a **non-admin browser query**. It MUST return
**only `{ name, displayName }`** for the user's `allowedInstances`. `gatewayUrl` and
`publicUrl` are **admin-read-only** and MUST NOT be returned to non-admin users:
the Image #22 example URL is an internal IP (`10.0.0.10:18789`), and `publicUrl`,
while non-secret, is gateway/topology metadata that should not be broadcast to every
user. This mirrors how `routing.ts` is careful to emit **names only**. Concretely:
the picker query selects from `instances` filtered to `allowedInstances` and
**projects out** every field except `name` and `displayName`; the admin instance-
management views are the only readers of `gatewayUrl`/`publicUrl`.

### Tables-vs-arrays decision

> **Discriminator:** reverse-lookup need **OR** cross-user sharing **OR** independent
> lifecycle ⇒ **table**; none of those ⇒ **array (or pointer)**.

| Binding | Choice | Why |
| --- | --- | --- |
| user ↔ instance | **array** (`profiles.allowedInstances`) | forward-only, bounded, loaded-with-profile |
| user ↔ agent | **table** (`userAgents`) | many-to-many, shared, per-binding lifecycle, reverse lookup |
| DEFAULT agent | **pointer** (`profiles.defaultAgentId`) | single-valued ⇒ "exactly one default" unbreakable, no transaction |
| agent ↔ subagents | **array** (`agents.subagents`) | bounded, always loaded with the agent, never queried alone |
| chat ↔ instance/agent/subagent | **snapshot fields** on `chats` | pin-at-creation; name snapshots survive unbind/rename |

### 3.6 The bridge secret store

**Exact format (Image #22, generalized per-provider).** The only place the secrets
live. OpenClaw keeps the shape verbatim (`device_identity` is an Ed25519 identity only
OpenClaw's handshake uses); a per-provider secret shape lets Hermes (API-key) plug in:

```jsonc
{
  "groups": {
    "<instanceName>": {                       // == Convex instances.name (join key)
      "provider": "openclaw",                  // selects the secret shape
      "url": "10.0.0.10:18789",             // gateway URL the bridge connects to
      "token": "<secret bearer token>",        // SECRET — connect auth.token
      "device_identity": "{\"id\":...,\"publicKey\":...,\"privateKey\":\"-----BEGIN PRIVATE KEY-----...\"}", // SECRET (OpenClaw only)
      "verbose": false,                        // operational flag
      "public_url": "https://gateway.example.com"  // mirrors instances.publicUrl (non-secret)
    },
    "<hermesInstanceName>": {                  // Hermes example (shape TBD — NOT FOUND)
      "provider": "hermes",
      "url": "https://hermes.example.com",
      "api_key": "<secret>",                   // SECRET — Hermes key (no device_identity)
      "verbose": false,
      "public_url": "https://hermes.example.com"
    }
  },
  "users": {                                   // OFFLINE BOOTSTRAP / FALLBACK ONLY — Convex wins
    "<email>": { "group": "<instanceName>", "agent_id": "<id>", "canonical": "<id>" }
  }
}
```

The `groups` key is intentionally the **same string** as `instances.name` — that
name is the *only* token that crosses the boundary, and it is non-secret. `users{}`
is preserved exactly but is **fallback** (§3.0 Collision B).

**Where it lives — mounted secrets file (with upgrade path).**

| Option | Verdict |
| --- | --- |
| Env vars (today's `config.ts`) | **Insufficient** for multi-instance: `config.ts` is env-only, fail-fast, no reload; a growing JSON-in-env-var is unwieldy, can't hot-reload, and bloats the process env (leaks into child processes / crash dumps). Fine single-instance; wrong multi-instance. |
| **Mounted secrets file** (K8s `Secret` / Docker secret at e.g. `/etc/openclaw-bridge/secrets.json`) | **CHOSEN.** Arbitrary-size JSON, perms `0400` root-only, never in process env, atomic rotation + `fs.watch` hot-reload. |
| External vault (Vault / cloud KMS) | **Production upgrade.** The loader interface (`SecretStore.getGroup(name)`) is identical whether bytes come from a file or a vault fetch — swapping is a loader change, not an architecture change. |

**Hot-reload.** A `SecretStore` abstraction wraps the file: `getGroup(instanceName)`
returns the per-instance secrets; an `fs.watch` (debounced) re-parses on change so a
**rotated token / added instance** is picked up **without a restart**. A live
connection keeps its current credentials until it closes; the next
`registry.acquire(...)` reconnect uses the rotated secret. Parse failures keep the
last-good snapshot and log a metadata-only error (never the secret bytes).

**The no-leak boundary (loud).** The secret store is read **only** inside
`provider.connect(secrets)`. Secrets never appear in a Convex mutation arg, an ingest
action body, a `traceEvent`, a log line, or any browser-bound payload. The bridge env
keeps only the bootstrap secrets that can't live in the routable store:
`BRIDGE_INGEST_SECRET`, `BRIDGE_SHARED_SECRET`, `CONVEX_HTTP_ACTIONS_URL`.

---

## 4. Streaming decoupled from Convex persistence + client reconciliation

**This section satisfies the hard requirement — it is NOT deferred.**

### 4.1 The premise, corrected (fix #5a)

The original framing ("the current bridge persists each delta via a Convex mutation,
per token") is **factually wrong**: `convex-writer.ts:99-194` already **coalesces**
deltas (~50ms flush, **one mutation per flush**, not per token).

But **coalescing is not decoupling**. Display still renders off `messages.text`,
which `internal.stream.appendDelta` patches; per-frame fluidity therefore remains
bounded by the Convex mutation round-trip. The hard requirement — *"NO latency from
Convex persistence of tokens; perfect display fluidity"* — is **not** met by a 50ms
flush. So this layer defines the **decoupling seam** (fix #5b).

### 4.2 What the migration killed vs what we add

The migration killed **SSE-per-turn that closes** (the Open WebUI pipe failure: the
turn's transport closes, the provider keeps emitting, tokens are lost). A
**persistent** (not per-turn) bridge→browser ephemeral channel for live deltas does
**not** reintroduce that failure: it never closes on a turn boundary, and Convex
remains the durable/reconnect/history store via `useQuery`. The browser↔Convex
reactive path stays exactly as the migration designed it; we **add** a live channel
*beside* it, we do not replace it.

### 4.3 The two channels (the seam)

Every normalized `message.delta` for a turn is dispatched to **both** sinks, behind
the same `RunManager` → sink boundary:

- **Durable sink (Convex, persistence).** Unchanged: the coalesced
  `ConvexWriter.appendDelta` → ingest → `internal.stream.appendDelta`. Guarantees
  durability, reconnect, history, and the authoritative final text. **This is the
  store of record.**
- **Live sink (ephemeral, fluidity).** A new `live-hub.ts` fans each raw delta
  immediately to subscribed browsers over a **persistent** bridge→browser channel
  (a long-lived WebSocket served by the bridge, or SSE that is **not** per-turn).
  Keyed by `chatId` + `runId`/`messageId`. **No Convex round-trip on the hot path**,
  so token cadence is gateway-limited, not persistence-limited.

The live sink carries **only display text** (the same deltas already destined for
`messages.text`); it is not a second source of truth and persists nothing.

### 4.4 The media fix lives behind the same seam (fix #1)

`convex-writer.ts addMedia` is **CHANGED, not unchanged.** Today
(`convex-writer.ts:206-221`) it POSTs a raw OpenClaw filesystem `path` (e.g.
`/home/node/.openclaw/media/outbound/<file>`) to the ingest action, which then
fetches the bytes (`bridge_ingest.ts:203-249`). The INVARIANTS name **"OpenClaw fs
paths"** as bridge-only secrets, and `config.ts:37` confirms `mediaOutboundDir` is a
bridge-env value — so shipping that path into a Convex action body (and risking it in
logs/traces) **violates the invariant.**

Corrected outbound-media path:
1. The bridge **reads the bytes locally** from `mediaOutboundDir` (it already has the
   dir and the traversal-validated relative path from the normalizer).
2. The bridge requests an upload URL from an ingest-side `generateUploadUrl` op
   (Convex File Storage; mirrors the existing browser `chats.generateUploadUrl`,
   `chats.ts:204-208`), uploads the bytes, and receives a `storageId`.
3. The bridge calls `addMedia` with **only** `{ storageId, filename, mimeType }` —
   **no path**.
4. The ingest action inserts the media part (`schema.ts:33-38` `messagePart` media
   variant already takes `storageId`).

**No filesystem path appears in any Convex mutation arg, action body, or
`traceEvent`.** The `addMedia` ingest op drops its `path` field entirely; the
`messageId`-correlated trace logs `mimeType` only (never filename/path), matching the
existing PHI discipline (`bridge_ingest.ts:243-247`).

### 4.5 Per-message serialization chain (fix #5c)

`HttpConvexWriter` uses **one global** serialization `chain`
(`convex-writer.ts:119`). Ordering is only required **per message**, so under the new
one-connection-per-instance fan-out, a single global chain serializes **every
tenant's** tokens together — cross-tenant head-of-line blocking on latency. Replace
the single `chain` with a **`Map<messageId, Promise>`**: ops for message A serialize
relative to each other (ordering preserved, load-bearing), but message B's ops do not
wait behind A's. The map entry is dropped on `finalize` to bound memory.

### 4.6 Client reconciliation in the ExternalStore

assistant-ui's `ExternalStoreRuntime` reconciles **two sources keyed by
`runId`/`messageId`**:

1. **Live ephemeral deltas (from `live-hub.ts`)** render **immediately** as the
   streaming message's text grows — this is the fluidity path.
2. **Convex `useQuery(messages, parts)`** is the durable/authoritative path.

Reconciliation rules:
- While a message's Convex `status === "streaming"`, the runtime prefers the **live
  ephemeral text** (longer/fresher) for display, but tool/media/reasoning parts come
  from Convex (`messageParts`), which the live channel does not carry.
- When `finalize` lands in Convex (`status` → `complete`/`error`/`aborted`,
  `stream.finalize`), **Convex becomes authoritative**: the runtime adopts the Convex
  final text and **drops the ephemeral buffer** for that `messageId` (no
  double-render; the final text is the corrected, sanitized authority).
- On **refresh / reconnect mid-stream** (the live channel was not connected for the
  earlier tokens), the Convex streaming-status message + its coalesced `text` is the
  **fallback**, so no tokens are lost — exactly the reconnect durability the migration
  bought. When the live channel re-subscribes, it resumes appending from the current
  point.

### 4.7 Live-channel auth — no bridge secret in the browser (fix per INVARIANTS)

The browser must **not** hold `BRIDGE_SHARED_SECRET` / `BRIDGE_INGEST_SECRET` (the
invariant forbids bridge secrets in the browser), so it cannot present one to open
the live channel. Resolution: a **short-lived Convex-minted ticket**.

1. The browser calls a Convex action that mints a **short-TTL, single-chat-scoped
   ticket** (an HMAC/JWT over `{ userId, chatId, exp }`, signed with a secret the
   **bridge** also knows — shared via deployment env, never exposed to the browser).
2. The browser opens the live channel to the bridge presenting **only the ticket**.
3. The bridge validates the ticket (signature + `exp` + that `chatId` belongs to
   `userId`) and subscribes that socket to the chat's live deltas. The ticket grants
   **read-only live display** for one chat and nothing else; it is not a bridge
   secret and cannot be replayed past `exp`.

This keeps the live channel authenticated **without** any standing bridge secret in
the browser, and per-chat scoping means a leaked ticket exposes at most one chat's
live tokens (which are also already persisted in Convex for that owner).

### 4.8 Scope of this layer

The provider interface (§2) is untouched by §4: the live/durable split sits **behind**
the `RunManager` → sink boundary, so a provider only ever emits the six normalized
events and is oblivious to how deltas are dual-routed.

---

## 5. UI capability surface

The "progressively surface everything" UI keys every affordance off the connected
user's `provider.capabilities()` (§2.2) and the reactive Convex tables — so a feature
the provider does not support is **not shown**, rather than shown-and-broken.

| UI affordance | Source | Gate |
| --- | --- | --- |
| **Streaming text** | live-hub deltas + `messages.text` (reconciled, §4.6) | `capabilities.streaming` |
| **In-flight tool status** | `messageParts` (kind `tool`, `phase`) via `useQuery` | always (tool parts already flow) |
| **Inbound shared files / media** | `messageParts` (kind `media`/`file`, `storageId`) | `capabilities.media` |
| **Outbound attachments** | browser upload → `outbox.attachmentIds` → `sendMessage` | `capabilities.attachments` |
| **Reasoning** | `messageParts` (kind `reasoning`) | additive; shown if present |
| **Run status** (working/compacting/error/aborted) | `messages.status` + `runId` | always |
| **Abort button** | calls a Convex action → bridge `provider.abort` | `capabilities.abort` (OpenClaw: local-finalize only, §2.4) |
| **History pane** | `provider.getHistory` via a bridge call | `capabilities.history` (OpenClaw: `false`, NOT FOUND) |
| **Conversation list** | `provider.listConversations` via a bridge call | `capabilities.listConversations` (OpenClaw: `false`, NOT FOUND) |
| **Instance picker (new chat)** | non-admin projected query `{ name, displayName }` over `allowedInstances` (§3.5.1) | shown when `allowedInstances.length > 1` |
| **Agent picker / default badge** | `userAgents` + `profiles.defaultAgentId` | shown when user has > 1 agent |
| **Subagent picker** | `agents.subagents[]` | `capabilities.subagents` (OpenClaw: `false`, grammar NOT FOUND) |

**Honesty rule applied to the UI:** abort, history, conversation-list, and subagents
are all currently `false` for OpenClaw (synthesized/NOT-FOUND). The UI therefore
**hides** them for OpenClaw users rather than rendering a control that silently
local-finalizes or errors. They light up the instant a capability flips to `true`
(e.g. a confirmed `v2026.5.19` RPC), with no UI rewrite — the capability flag is the
single switch.

---

## Invariants honored — enforcement map

| Invariant | Where enforced |
| --- | --- |
| **Secrets (gateway tokens, device identities) live ONLY in bridge / secret store, never in Convex or browser** | §3.6 secret store is read only inside `provider.connect`; §3.0 Collision A keeps `token`/`device_identity` off the `instances` table; §2.6 secret boundary. Convex `instances`/`agents`/`routing.ts` carry **names only**. |
| **`BRIDGE_INGEST_SECRET` / `BRIDGE_SHARED_SECRET` never in Convex table or browser** | Bridge env only (§3.6 bootstrap secrets). `POST /send` auth (`server.ts:177-182`) and ingest auth (`bridge_ingest.ts:102-118`) compare them constant-time server-side. The §4.7 live-channel uses a **Convex-minted ticket**, never a bridge secret in the browser. |
| **Provider API-key plaintext / Convex deploy keys never in a table or browser** | Per-provider `api_key` lives in the bridge secret store (§3.6); Convex stores `provider` + names only. Service-account API keys remain hashed in `apiKeys` (`schema.ts:324-335`) — unchanged. |
| **OpenClaw fs paths are bridge-ONLY secrets** | §4.4 — `addMedia` is **CHANGED**: bridge reads bytes from `mediaOutboundDir` locally, uploads via ingest-side `generateUploadUrl`, passes **only** `storageId`+`filename`+`mimeType`. **No path** in any mutation arg, action body, or `traceEvent`. |
| **Convex stores NON-SECRET routing metadata only** | §3.1-3.5 — every Convex delta (`provider`, `publicUrl`, `agents`, `userAgents`, `defaultAgentId`, `allowedInstances`, chat snapshots) is non-secret names/ids. `routing.ts` (single resolver, §3.1) emits `instanceName`/`agentId`/`canonical` only. |
| **Never log PHI / message content** | §4.4 media trace logs `mimeType` only; ingest traces are metadata-only (`bridge_ingest.ts:243-247`); live-hub carries display text but **persists nothing** and is not logged. |
| **Schema additions to EXISTING tables must be OPTIONAL (push validates rows)** | §3.2-3.5 — all deltas to `instances`/`profiles`/`chats` are `v.optional(...)`; `provider` absent ⇒ `"openclaw"`. New tables (`agents`, `userAgents`) may carry required fields (precedent: `auditLog`, `roles`). |
| **Pin to OpenClaw `v2026.5.19`; no multi-version** | §2.4 adapter targets the one pinned grammar; abort/history/listConversations/subagents marked **NOT FOUND** for this version rather than invented. |
| **No fabricated provider surface (HONESTY RULE)** | §2.4 abort (`false`), history/listConversations (`false`); §3.5 subagent grammar **NOT FOUND**, `capabilities.subagents=false` for OpenClaw; §2.5 Hermes transport **NOT FOUND**, internals TBD, only the six events + method surface guaranteed. |
| **Gateway topology not broadcast to non-admin users** | §3.5.1 — instance picker projects **only** `{ name, displayName }`; `gatewayUrl`/`publicUrl` stay admin-read-only. |

---

*Document written to `docs/BRIDGE_ARCHITECTURE.md` (787 lines). All cited source line references verified against ground truth (`normalizer.ts:361`, `openclaw-client.ts:129`, `convex-writer.ts:119`, `session-keys.ts`, `routing.ts`, `schema.ts`, `bridge_ingest.ts`, `config.ts`). All six red-team fixes incorporated; the streaming decoupling (§4) is resolved, not deferred.*