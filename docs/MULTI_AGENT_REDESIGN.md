# Multi-Instance / Multi-Agent / Multi-Bridge Redesign

> Status: **DESIGN + EXECUTION PLAN** (2026-06-07). Authoritative contract for the
> M:N user↔instance↔agent redesign with bridge-driven agent discovery and
> OpenClaw+Hermes multiplexing. Companion docs: `BRIDGE_ARCHITECTURE.md`,
> `BRIDGE_PROTOCOL.md` (partly stale — see `OPENCLAW_RESEARCH.md` §5),
> `OPENCLAW_RESEARCH.md` (provider ground truth), `PROJECT_STATE.md`.
>
> PRIMARY-SOURCE RULE: fixtures/live captures win over public docs. Every
> provider shape is normalized in the bridge; the app sees a stable contract.
>
> PROVENANCE: validated by the `advisor` (6 points incl. the IDOR blocker + spike-first
> reorder) and red-teamed by `au-challenger` (2 added BLOCKERS B1/B2 + H1–H4 + M1–M4 +
> 3 blind-spots) — all incorporated below (search "red-team").

## 0. Why now — the production bug this fixes structurally

Prod fails with **"Agent 'main' no longer exists in configuration"**: the bridge's
`OPENCLAW_AGENT_ID` env is a hand-entered id that drifted from what the gateway
actually has. The root cause is **hand-entered agent ids that can reference a
non-existent agent**. This redesign removes that class of bug by only ever
binding agents **discovered from the gateway** (via `agents.list`).

> **HONESTY (post code-review): which door closes in WHICH phase.** The runtime
> fix is NOT complete in Phase 1. The bug has THREE doors:
> - **UI entry** — *closed in Phase 1*: an admin can only assign discovered agents
>   (`agentDiscovery:true` instances; manual = the explicit M1 exception).
> - **Migration seed** — *closed in Phase 1*: the reconciling migration never seeds
>   a phantom agentId (§4.0/B1).
> - **Runtime dispatch** — **NOT closed in Phase 1, closes in Phase 2.** The bridge
>   still builds the gateway sessionKey from its env `OPENCLAW_AGENT_ID`, **ignoring
>   the resolved `agentId` Convex sends in the body** (`bridge src/session.ts` +
>   `parseSendBody`). So a stale env id still hard-fails at runtime, and the B2
>   stale-vs-deleted re-bind is correct in Convex but has **no effect on the actual
>   send** until **Phase 2 makes the bridge route by the body's agent** AND a live
>   e2e proves it. Phase 1's dispatch v2 is the *correct, deploy-safe* Convex layer
>   (additive; un-migrated users fall back to legacy routing → prod behaviour
>   unchanged), not the runtime cure.
>
> **Therefore Phase 1 is SAFE TO DEPLOY (additive backbone + inert UI), but does
> not by itself end the prod "Agent X" error.** Do not claim otherwise in release
> notes. The runtime fix is the headline of Phase 2.

Acceptance (Phase 2, with the bridge routing by body + a live e2e): an agent
deleted on the gateway after a successful poll does not hard-fail a chat — it
re-binds to the default and surfaces it; an instance *blip* (failed poll) serves
the binding unchanged.

## 1. Spike #0 — live ground truth (DONE, partial)

Captured against the running **local OpenClaw 2026.6.1** gateway (CLI
`agents list --json`, trusted loopback, token auth):

```json
[
  { "id": "olivier", "identityName": "Olivier", "identitySource": "config",
    "workspace": "…", "agentDir": "…", "model": "openai/gpt-5.5",
    "bindings": 0, "isDefault": true },
  { "id": "pissey", "identityName": "Pissey", "identityEmoji": "⚔️",
    "model": "openai/gpt-5.5", "bindings": 0, "isDefault": false }
]
```

Confirmed facts that drive the schema:
- An agent = `{ id, identityName(+identityEmoji), model, isDefault, workspace,
  agentDir, bindings }`. **`isDefault` is native at the instance level.**
- `bindings: 0` → no email/peer routing configured → confirms OpenClaw has **no
  native per-email agent scoping**; auto-assignment is a webchat convention.
- Gateway RPC method confirmed by `docs/gateway/protocol.md@v2026.5.19`:
  **`agents.list`** ("returns configured agent entries, including effective model
  and runtime metadata"), plus `sessions.list`, `models.list`,
  `sessions.subscribe`.

REMAINING Spike work (Phase-1 e2e gate, NOT design-blocking — the bridge
normalizes, so the schema is version-tolerant by construction): the exact **WS RPC
`agents.list`** payload (vs the CLI shape) on **both 5.19 and 6.1**. STATUS: the WS
probe is currently **blocked on device-identity reprovisioning** — the running 6.1
container has a device paired from a prior session, and the `.env.example` dev
identity hits the known `DECODER unsupported` `\n` gotcha (memory
`openclaw-webchat-bridge-prod-gotchas`; fix = `fix-devid.mjs` + re-pair). The
bridge `normalizeOpenClawAgent` (server.ts) is tolerant to CLI↔RPC field drift
(id|agentId, identityName|name|identity.name, model string|{primary}, isDefault|
default), so the WS capture is deferred to the end-to-end bridge run (when device
provisioning is sorted) and recorded then as a fixture.

## 2. Current architecture (as mapped)

- **Bridge = mono-tenant.** One OpenClaw WS connection per process from env
  (`OPENCLAW_GATEWAY_URL/TOKEN/DEVICE_IDENTITY/AGENT_ID/CANONICAL`). The bridge
  **ignores** `instanceName/agentId/canonical` in the `/send` body and uses its
  env. A clean `BridgeProvider` abstraction exists (`src/core/provider.ts`:
  `kind: "openclaw"|"hermes"`, `capabilities()`, `Routing`), but the OpenClaw
  path is hard-wired, not yet a registry of providers.
- **Convex routing = single-valued per user.** `routing.ts:resolveTargetForProfile`
  → `{instanceName, agentId, canonical, source}` via per-user override XOR group
  (`groups`: per-user|shared). Instance/agent are **free-text strings**, no FK,
  no discovery. `chats` store **no** instance/agent — routing is resolved lazily
  at first send from the profile.
- **No agent enumeration anywhere.** Health polling exists (`/health` cron) but
  there is no `/agents` and no `/capabilities` consumed by the app.

## 3. Target architecture

### 3.1 Data model (Convex)

```
instances (EXTEND)
  name            string  (PK by name; the bridge maps name -> secrets)
  kind            "openclaw" | "hermes"          // NEW
  gatewayUrl      string
  displayName?    string
  capabilities?   object  (cached from bridge /capabilities)   // NEW
  lastDiscoveryAt? number                                       // NEW
  discoveryError? string | null                                // NEW (stale cache reason)

instanceDiscovery (NEW — per-instance poll OUTCOME; the truth dispatch keys on)
  instanceName    string
  lastPollAt      number
  lastPollOk      boolean   // last discovery succeeded? (down/stale => false)
  lastOkAt?       number    // last time it succeeded (for staleness window)
  error?          string | null
  index by_instance [instanceName]
  // RATIONALE (red-team B2 / blind-spot-1): a single `stale` boolean on `agents`
  // CANNOT distinguish "agent absent in a SUCCESSFUL poll" (=> deleted on gateway
  // => fall back) from "unknown because the poll FAILED" (=> serve last-good,
  // never hard-fail on an instance blip). Poll outcome lives here, presence on
  // `agents` rows below. Dispatch combines the two (§3.3).

agents (NEW — resilient cache of bridge-discovered agents; last-good, never emptied)
  instanceName    string   (-> instances.name)
  agentId         string   (provider-defined, e.g. "olivier")
  displayName?    string   (identityName)
  emoji?          string
  model?          string
  isDefaultOnInstance? boolean
  source          "discovered" | "manual"      // manual => UNVERIFIED (see M1)
  presentInLastOk boolean   // was this agent in the most recent SUCCESSFUL poll?
                            // false + instanceDiscovery.lastPollOk => deleted on gateway
  firstSeenAt     number
  lastSeenAt      number    // last successful poll that INCLUDED it
  index by_instance [instanceName], by_instance_agent [instanceName, agentId]
  // A failed poll NEVER deletes rows or flips presentInLastOk; only a SUCCESSFUL
  // poll updates presence (sets true for seen ids, false for absent ones).

userAgents (NEW — the M:N join; user↔instance is DERIVED from this, no 2nd table)
  userId          Id<"users">
  instanceName    string
  agentId         string
  isDefault       boolean   // INVARIANT: exactly one true WHENEVER >=1 row exists
  source          "auto" | "manual" | "migrated"   // migrated => reconciled, see §4.0
  needsReassignment? boolean // migration could not match a discovered agent (B1)
  createdAt       number
  index by_user [userId], by_user_instance_agent [userId, instanceName, agentId]
  // One-default enforcement (red-team H3): set-default / assign MUST read the full
  // `by_user` set (range read) inside the mutation, NOT a point lookup — Convex OCC
  // serializes a range-read↔insert conflict; a point lookup lets two concurrent
  // first-assigns each set isDefault:true => two defaults.

chats (EXTEND — bound to a target at creation; WRITE-ONCE after first dispatch)
  instanceName?   string    // NEW — chosen agent's instance
  agentId?        string    // NEW — chosen agent
  // Binding is WRITE-ONCE after the first successful dispatch (red-team H1): the
  // sessionKey embeds agentId+canonical, so silently swapping the agent forks the
  // gateway session AND changes the idempotencyKey (retry double-send). A
  // deliberate agent switch is an explicit, acknowledged user action that re-binds
  // + surfaces "Nouvel agent : X" — never a silent field rewrite.
  // legacy chats (both null) -> resolve to the user's default at dispatch (§3.3).
```

`groups`, `profiles.groupId/overrideInstance/overrideAgentId` are **read once by
the migration, then write-never** (red-team H4). The write paths
(`admin.setUserRouting`, `createGroup`/`updateGroup`/`deleteGroup`) and their UI are
**retired in Phase 1** — leaving them wired makes an admin edit a silent no-op
(routing now comes from `userAgents`/chat), exactly the operator-trust hazard this
redesign exists to kill. The columns stay only so old rows validate.

See §4.0 for the reconciling migration (NOT a naive seed — red-team B1).

### 3.2 Authorization invariant — [BLOCKING, the security crux]

The bridge moves from "ignore the body" to "route by the body". Convex becomes the
**sole** authorization point. Enforce, server-side, in BOTH places:

1. **Chat creation** (`createChat` with `instanceName/agentId`): assert
   `(userId, instanceName, agentId) ∈ userAgents`. Reject otherwise.
2. **Dispatch** (`bridge.dispatch`): re-resolve the chat's `(instanceName,
   agentId)` and re-assert membership before POSTing `/send` (defense in depth —
   userAgents may have changed since chat creation).

Without this, a user could bind a chat to an arbitrary instance/agent (IDOR) and
the body-routing bridge would execute it faithfully. This is the #1 "rocket to
Mars" hole and is non-negotiable.

**Membership is necessary but NOT sufficient** (red-team B2): `userAgents` is a
Convex table the gateway knows nothing about. An agent deleted/renamed on the
gateway after a successful poll leaves the row valid but the agent gone → the prod
bug at runtime. So dispatch resolution (§3.3) adds a discovered-set condition keyed
on **poll outcome** (`instanceDiscovery.lastPollOk` + `agents.presentInLastOk`),
NOT membership alone.

### 3.3 Routing resolution v2 (stale-vs-deleted aware, write-once, no silent swap)

`resolveTargetForChat(ctx, chat, { isRetry })`. The order encodes red-team B2/H1/H2:

1. **Bound chat** (`chat.instanceName && chat.agentId`):
   - Membership `(user,instance,agent) ∈ userAgents` must hold (else revoked →
     treat as unbound, step 3).
   - **Stale vs deleted** (B2): if `instanceDiscovery.lastPollOk === false` (instance
     down / never polled) → **serve the binding unchanged** and let the gateway
     arbitrate (a blip must NOT break a working chat). If `lastPollOk === true` AND
     the agent row has `presentInLastOk === false` → the agent was **deleted on the
     gateway** → go to re-bind (step 2).
   - Otherwise → use the binding. **Done.**
2. **Re-bind (deleted agent, NEW turn only)**: pick the user's default (step 3's
   target), **persist** it onto the chat (binding stays write-once-stable thereafter)
   and **surface** "L'agent précédent n'existe plus — bascule sur : X". **Never on a
   retry/in-flight outbox row** (`isRetry`) — H1: a retry must keep the original
   sessionKey so the idempotencyKey is stable (no double-send). On a retry of a
   deleted agent, fail with a classified message instead of swapping.
3. **Unbound / legacy chat** → the user's agent set:
   - exactly 1 agent → use it (regardless of `isDefault`, H2);
   - else → the `isDefault` row;
   - persist the chosen binding onto the chat (so the next turn is stable).
4. **No agents at all** → fail with "Aucun agent assigné — contactez votre
   administrateur" (surfaced at chat-CREATION time too, §3.6), never a silent drop.

`canonical` is treated as **immutable after first dispatch** (blind-spot 2): it is
part of the sessionKey; changing it forks every session like an agent swap does.

### 3.4 Bridge protocol v2 (additive, capability-negotiated)

New/changed bridge HTTP endpoints (all behind `BRIDGE_SHARED_SECRET`, except
`/health`):

- `GET /capabilities` → per-instance provider kind + `ProviderCapabilities`
  (incl. `agentDiscovery: boolean`). The app caches this on `instances`.
- `GET /agents?instance=<name>` → the bridge asks the provider for its agents and
  returns a **normalized** list `[{ agentId, displayName?, emoji?, model?,
  isDefaultOnInstance?, raw }]`. OpenClaw adapter → `agents.list` RPC over the
  per-instance operator WS. Hermes adapter → configured agents/models (Phase 3).
  If the provider can't enumerate → `agentDiscovery:false` + the app falls back to
  `source:"manual"` admin entry. **`source:"manual"` agents are UNVERIFIED** (red-team
  M1): they re-introduce the hand-typed-id risk, so the §0 "admin can never assign an
  absent id" guarantee is **scoped to `agentDiscovery:true` instances**. Manual agents
  must render as "non vérifié" in the UI (never as "discovered"), and dispatch to one
  that the gateway rejects must surface a DISTINCT classified error ("id non reconnu
  par la gateway"), not a generic failure. Hermes (§3.9) is the near-term case.
- `POST /send` (CHANGE) → **route by `instanceName`** to the right provider in the
  registry (stop ignoring it). Body unchanged otherwise. An **unknown
  `instanceName`** (typo, deleted, migration drift) is **rejected with a classified
  non-PHI error code** (mirroring `classifyGatewayError`), never silently routed to
  a default provider (red-team M2 — a routing typo must not hit the wrong gateway).

Convex polls `/capabilities` + `/agents` on a cron (extend the health poller) and
upserts `instances.capabilities` + the `agents` cache. Discovery failure → mark
`agents.stale=true`, keep last-good rows (never delete to empty).

### 3.5 Multiplexing = per-instance fault isolation (the robustness contract)

- `ProviderRegistry`: `instanceName -> BridgeProvider` (lazy connect, per-instance
  secrets). One OpenClaw operator WS **per instance**; Hermes is HTTP per instance.
- **Fault isolation:** instance B's gateway down ⇏ instance A's chats break.
  Per-instance connect/backoff state; the SessionRegistry keys by
  `(instanceName, chatId)` and selects the provider.
- **Resilient discovery cache:** `agents.list` is a WS RPC → fails if the instance
  is down. The `agents` table serves the **last good** result (marked `stale`),
  never an empty list (which would break binding + the picker).
- **Per-instance secrets:** the bridge loads `{token, deviceIdentity, canonical}`
  per instance from a JSON env map (e.g. `BRIDGE_INSTANCES_JSON`) or per-instance
  vars. The device-identity newline gotcha (single `\n`) multiplies per instance —
  validate each with `crypto.createPrivateKey` at boot (reuse `fix-devid` logic).

### 3.6 Auto-assignment, default agent, ≥1 agent

- On user approval + instance assignment, the admin UI calls `/agents` per chosen
  instance and offers the discovered agents to assign. **Auto convention**
  (best-effort): pre-select the agent whose `agentId == user.canonical` (the
  OpenClaw per-person pattern) if present; else the instance default. The admin
  can always override. **Reliable path = explicit admin assignment** (auto is a
  convenience, surfaced as such — cf. `surface-known-gaps-before-prod`).
- **Exactly one default whenever ≥1 agent exists** (red-team H2, strengthened):
  `setDefaultAgent` clears the previous default in the same mutation; `removeAgent`
  **re-elects** a default when it removes the current one (else a user keeps agents
  but loses its default → dispatch fallback breaks). The dispatch fallback also
  degrades: `count==1` uses the sole agent regardless of the flag.
- **Concurrency** (red-team H3): one-default enforcement MUST read the full
  `by_user` set (range read) inside the mutation, not a point lookup, so Convex OCC
  serializes concurrent first-assigns (range-read↔insert conflict).
- **≥1 agent**: approving a user with no agent, or removing the last agent, is
  allowed but **chat creation is blocked** with a clear message until ≥1 exists.
- **Currently-unrouted active users** (red-team M4): users with no group/override
  today seed NOTHING (no resolved target). This is NOT an access regression (they
  were never routable — sends failed with "unrouted"), but it IS a behavior change:
  the block now fires at chat-CREATION with "Aucun agent assigné — contactez votre
  administrateur" instead of at send time. Surfaced as intended in the migration notes.

### 3.7 Chat creation + intelligent agent picker

- New chat: query `userAgents`. **Exactly 1** → create the chat bound to it
  (no prompt). **>1** → open the agent picker.
- Picker UX: grouped by **bridge kind** (OpenClaw/Hermes badge) then **instance**,
  each agent row showing displayName + model + a "défaut" marker, the user default
  highlighted and pre-focused; searchable; keyboard-navigable; one click binds +
  creates. Designed for an informed choice (which instance, which bridge).
- **Impersonation** (red-team M3): the picker and its `userAgents` query are
  **effective-user scoped** (the impersonated target, matching what `createChat`
  authorizes). Reading the real admin's agents while authorizing the target's would
  bounce every bind under impersonation.

### 3.8 Capability-driven, redesigned admin UI

- **Instances tab:** cards per instance — kind badge (OpenClaw/Hermes), gateway
  URL, live health, capabilities, discovered-agent count, "Rafraîchir la
  découverte" action, `stale` indicator.
- **Agents (per instance):** read-only list of discovered agents (id, name, model,
  default) with a manual-add fallback when `agentDiscovery:false`.
- **Users tab:** replace free-text override/group with an **Access editor** —
  assign instances → per instance pick agents (from discovered list, checkboxes) →
  set the global default (radio). Auto-prefill on approval; override always.
- **New-chat picker** (§3.7).

### 3.9 Hermes adaptation (Phase 3 — wired in a few days)

Hermes = OpenAI-compatible HTTP/SSE, single API key, multi-tenancy enforced by the
bridge (map user → `session_id`). The `HermesProvider` implements the same
`BridgeProvider` contract; `/agents` returns the configured model(s)/agent(s);
`media` = inline images only; conversation list via `/api/sessions`. Exact
runs-events SSE vocabulary + version pin = capture before relying (see
`OPENCLAW_RESEARCH.md` §6). The app is **Hermes-ready by contract** now; the
adapter lands when Hermes is connected.

## 4.0 Migration — REMOVED (2026-06-07)

> The reconciling legacy→userAgents migration described below was **removed** at
> the operator's request (sole user, no migration needed). Legacy routing code is
> gone; a user with no `userAgents` gets a clear `no_agent` message and self-assigns
> via the Users → "Gérer les agents" editor.
>
> **Schema fully cleaned (2026-06-07):** the legacy columns (`groups` table +
> `profiles.{groupId, overrideInstance, overrideAgentId, allowedChatPrefixes}`,
> `userAgents.needsReassignment`, source `"migrated"`) were **DROPPED** — no data
> to preserve (operator-confirmed). Convex rejects dropping a column while any doc
> still carries it, so the deploy is a **clean-slate**: wipe the target deployment's
> app data before `convex deploy` (see DEPLOYMENT.md → "Schema-clean deploy"). Proven
> locally (`dev.reset` purged the DB → schema valid on empty → app re-bootstrapped
> admin clean → no surprise). The original migration design is kept below for history.

<details><summary>Historical design (not implemented)</summary>

The current routing sources produce agentIds **not guaranteed to exist on the
gateway**: `group-per-user` → `agentId = canonical` (email slug — matched a real
agent in the spike only by luck), `override` → hand-typed `overrideAgentId`,
`group-shared` → hand-typed `sharedAgentId`. A naive "seed `userAgents` from the
resolved target" therefore re-seeds the prod bug for every user. The migration MUST:

1. **Run discovery FIRST** (populate `agents` + `instanceDiscovery` from a
   successful `/agents` poll) — migration cannot reconcile against an empty cache.
2. For each user with a resolvable current target `(instance, agentId)`:
   - **agentId ∈ discovered set** → seed `userAgents{source:"migrated"}`, mark default.
   - **not discovered, but instance has a default agent** → seed the **instance
     default**, `needsReassignment:true`, and **audit** it (this changes *who
     answers* the user — surface in the admin UI as "réassignation requise").
   - **not discovered, no instance default** → seed nothing, leave the user
     agentless (chat creation will block with the clear message, §3.6).
3. **Never** seed a phantom (non-discovered) agentId.
4. **Ordering vs in-flight outbox**: seed `userAgents` + discovery BEFORE flipping
   the dispatch resolver to the new path; during the window the resolver tolerates
   both sources (chat-binding/`userAgents` first, legacy `routing.ts` fallback) so a
   `pending` outbox row mid-migration cannot resolve against half-built state.

Acceptance: after migration, assert `∀ userAgents row: source≠"manual" ⇒
(instance,agentId) was present in a successful discovery` (the B1 gate).

</details>

## 4. Execution plan (phased, minimal blast radius, gated)

Every phase gate = `tsc` + `vitest` + `vite build` green, **advisor** review,
**au-code-reviewer** challenge, and a **live test** against the local harness.

### Phase 1 — Mono-instance agent discovery + chat binding (FIXES PROD)
Scope: the existing single instance. No multi-instance yet.
1. Spike completion: WS `agents.list` fixture on 5.19 + 6.1; record divergence.
2. Bridge: `GET /agents` (+ normalizer) and `GET /capabilities` for the one
   configured instance; `agents.list` RPC in the OpenClaw path. (Body routing not
   yet required — still one instance.)
3. Convex: `agents` + `instanceDiscovery` tables + discovery poller (cron) →
   resilient cache (failed poll never empties / never flips presence); `userAgents`
   table + mutations (`assignAgent`, `removeAgent` with re-election, `setDefaultAgent`)
   enforcing exactly-one-default via a `by_user` **range read** (H3) + the grant
   whitelist; the **reconciling migration of §4.0** (NOT a naive seed — B1).
4. Convex: `createChat` accepts + **authorizes** `(instanceName, agentId) ∈
   userAgents` (§3.2); `chats.instanceName/agentId` **write-once** (H1); dispatch
   `resolveTargetForChat` with the stale-vs-deleted + re-bind-not-on-retry logic
   (§3.3/B2/H1) + re-asserts membership; classified message on no-agent / unknown
   instance / unverified-manual reject (M1/M2).
5. Convex+UI: **retire** the legacy write paths `admin.setUserRouting`,
   `createGroup`/`updateGroup`/`deleteGroup` and their UI controls (H4) — read-once
   by the migration, write-never after.
6. Frontend: new-chat picker (auto when 1, effective-user scoped — M3) + the Users
   Access editor (single instance) + Instances tab showing discovered agents +
   `needsReassignment` surfacing + `stale`/poll-outcome indicator.
7. **Prod fix validation (3 doors, §0):** UI cannot assign an absent id; migration
   seeds no phantom; gateway-delete re-binds (not hard-fail) while a blip serves the
   binding. All three asserted live.

### Phase 2a — Bridge BODY-ROUTING (THE prod fix) — ✅ DONE + LIVE-PROVEN (2026-06-07)
The actual runtime fix for "Agent <env-id> no longer exists": the bridge routes by
the request BODY (agentId + canonical Convex resolves), not a static env. Convex
already sent these (Phase 1); only the bridge ignored them.
- `config.ts`: DROP `OPENCLAW_AGENT_ID`+`OPENCLAW_CANONICAL` (the static agent-id
  env was the bug mechanism); ADD optional `OPENCLAW_INSTANCE_NAME` (served
  instance, == Convex `instances.name` == poller `BRIDGE_INSTANCE_NAME`).
- `server.ts`: parse*Body REQUIRE agentId+canonical (fail-loud 400, NO env
  fallback); M2 `isInstanceMismatch` → 409 when body instance ≠ served (opt-in);
  health + a non-PHI `routed` log reflect the ROUTED agent; `/capabilities`
  returns the served instance.
- `session.ts`: `acquire(SessionRouting)` builds the sessionKey from the body
  agent+canonical; keyed by chatId with RE-KEY on change (close stale → no leak).
- Gates: tsc + build + 88 bridge tests (15 new) + advisor (4 points applied) +
  **live e2e**: picker→chat bound to `pissey`→send → `routed agent=pissey
  canonical=<user>` + /health connected; gateway accepted the send + created a run
  (old bug failed earlier); M2 forged `family`→409; missing routing→400. (Agent
  RUN blocked only by a local codex-harness `ENOENT`, unrelated to routing.)

### Phase 2b — Multi-instance + ProviderRegistry + fault isolation (DEFERRED)
Not required by the prod fix — deployment is **one bridge per instance**, so a
single bridge serving N instances buys nothing now (advisor-agreed scoping). Do
this only if that model changes.
1. Bridge: `ProviderRegistry`, per-instance secrets (JSON env), per-instance
   OpenClaw provider, `/send` routes by `instanceName`, per-instance backoff.
2. Convex: discovery across all instances; resilient stale cache; `instances.kind`.
3. Frontend: Instances tab multi-instance; Access editor multi-instance; picker
   grouped by instance.
4. Live: two local OpenClaw instances; isolation test (kill B, A keeps working).

### Phase 3 — Hermes provider
`HermesProvider` (OpenAI-compatible), `/agents` for Hermes, session mapping,
inline-image media, capability flags. Live test against a local Hermes (stand one
up if feasible). Picker shows OpenClaw + Hermes grouped by bridge kind.

### Phase 4 — Graphical polish + hardening
Full visual redesign pass (cards, badges, picker micro-interactions, a11y),
dead-code sweep, test-coverage top-up, end-to-end live matrix on both OpenClaw
versions, advisor + code-reviewer final gate.

## 5. Open risks / capture-before-relying
- Exact WS `agents.list` payload vs CLI shape, on 5.19 + 6.1 (Phase-1 gate).
- Hermes runs-events SSE vocabulary, version pin, per-user auth, media (Phase 3).
- Multi-instance device-identity provisioning (per-instance pairing on the NAS).
- Migration correctness: every currently-routable user must get an equivalent
  `userAgents` default (no access regression).
```
