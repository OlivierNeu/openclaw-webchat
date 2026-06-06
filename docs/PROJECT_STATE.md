# PROJECT STATE — openclaw-webchat (resume anchor)

**Purpose of this file:** the single, durable, detailed snapshot to RESUME from
after a context compaction. Read this first. It is kept current as work lands.
Last verified-green: **2026-06-06** — `tsc src` 0, `tsc convex` 0, `vitest` 127
(convex+routing, incl. UI-9 feedback 4) + mcp 36, `vite build` OK.

Companion docs (authoritative for their area): `OBSERVABILITY_PLATFORM_PLAN.md`
(contract), `OBSERVABILITY_RESEARCH.md`, `OBSERVABILITY_REVIEW.md` (28-item
punch-list), `FILTERS_SPEC.md`, `ROUTING_RESEARCH.md` (router decision+contract),
`CONVEX_MIGRATION.md`, `BRIDGE_PROTOCOL.md`. Memory index also points here.

---

## 1. What this is + stack + how to run

A public, forkable, professional bridge between **OpenClaw** (event-driven
WebSocket agent gateway) and a stable webchat. Three runtimes:
- **Convex** backend (app: users, chats, RBAC, observability, API) — LOCAL
  anonymous deployment. Query origin `http://127.0.0.1:3212`; `.site` origin
  (HTTP routes / API) `http://127.0.0.1:3213`. Vite dev on **:5174**.
- **Vite + React 19** frontend SPA (this repo `src/`).
- **Node/TS bridge worker** — holds the persistent OpenClaw operator WS + runs
  the normalizer. **NOT BUILT YET** (the major remaining milestone — §5).
- **`mcp/`** — standalone MCP server + CLI (thin proxy over `/api/v1`).

Stack: Vite 8 · React 19 · TypeScript · Convex 1.39 · `@convex-dev/auth` 0.0.80
(Google + dev Anonymous) · **TanStack Router v1** (code-based) · shadcn/ui (unified
`radix-ui`) · Tailwind v4 (CSS-first) · assistant-ui + `@assistant-ui/react-markdown`
+ remark-gfm · dnd-kit · zod · vitest + convex-test.

Run: `bash dev.sh` (convex dev :3212 + vite :5174 — does NOT global-pkill).
Tests: `npx vitest run` (convex+routing) and `npm --prefix mcp test`.
Gates: `npx tsc --noEmit` (src), `npx tsc -p convex/tsconfig.json --noEmit`,
`npx vite build`.
Mint a dev API key (dev-gated): `CONVEX_AGENT_MODE=anonymous npx convex run dev:seedApiKey '{"name":"x","roleKey":"observer"}'`.

---

## 2. What's DONE + verified (by area)

All gated (tsc+build+vitest) and, where noted, live-verified via curl. **UI built
AFTER the chrome-devtools MCP disconnected is tsc+build-verified ONLY — browser
confirmation PENDING (§5.1).**

1. **Convex migration + auth.** ConvexAuthProvider (mandatory), Google + dev
   Anonymous. JWT key gotchas: see memory `convex-auth-local-jwt-keys`.
2. **RBAC core + impersonation + audit.** `lib/access.ts`: `ensureProfile`
   (single role-writer, first-admin OCC bootstrap), `getActor` (effective-vs-real
   identity), `requireActive` (effective), `requireAdmin` (REAL identity),
   last-admin guard (`admin.setRole`/`applyRoleChange`), `auditLog` attribution.
   Admin impersonation ("view/act as a user") with full traceability (real actor →
   target). Verified live earlier.
3. **Theme system.** Convex source of truth + localStorage anti-flash cache;
   admin default + per-user pref; single top-right menu. `ThemeShowroom` (Theme
   tab) = living style guide incl. a Filtres section.
4. **Chat sidebar.** Projects (groups), pin, per-chat color, dnd-kit reorder +
   cross-container assign, collapsible sections, resizable + collapsible sidebar.
5. **Confirm/prompt modals.** `useConfirm`/`usePrompt` (`components/ConfirmDialog`),
   shadcn AlertDialog/Dialog, type-to-confirm guard for destructive deletes.
6. **OWUI-style chat.** No-bubble assistant + avatar/name header, subtle `--muted`
   user bubble, centered readable column (`--oc-thread-w`), workspace is FLEX (not
   grid). **Markdown** for assistant turns (`MarkdownText`, `.oc-md`); user/system
   stay plain.
7. **Observability platform (increments 1–8) — DONE.** Contract:
   `OBSERVABILITY_PLATFORM_PLAN.md`.
   - RBAC MATRIX engine (`lib/rbac.ts`: PERMISSIONS, BUILTIN_ROLES
     pending/user/admin/observer/agent, wildcard, `seedBuiltinRoles`,
     `ensureRolesSeeded`).
   - **Service accounts + API keys** (`lib/apikeys.ts` CSPRNG `oc_live_<40 b62>` +
     SHA-256 hash-only, mint=ACTION show-once; `apiKeys.ts`: create/mint/revoke/
     list, `deleteServiceAccount` cascade, listRoles/createRole/updateRolePermissions).
   - **Traces** (`observability.ts`: single writer `writeTraceEvent`/`recordEvent`
     forces `redacted:true`; instrumented send/stream/bridge_ingest/bridge —
     metadata-only, correlationId; retention purge cron). Filters supported.
   - **KPI** (`kpi.ts` hourly rollup cron, idempotent upsert by bucket+metric;
     dashboard `KpiTab` pure-SVG charts).
   - **Integrations** (`integrations/*`: Opik REST + Langfuse OTLP, env-only secrets,
     metadata-only mapping, per-vendor cursor flush cron, graceful no-op, failure state).
   - **Anomalies + heartbeat + OpenClaw query** (`anomalies.ts` detectors +
     auto-resolve + resolve surface + `by_status_kind` index; `openclaw.ts`
     `queryOpenClaw` via bridge, graceful no-op).
   - **`/api/v1`** (`http.ts`): key-authed `health` (no auth), `traces`, `kpi`,
     `anomalies` (GET+POST report + POST resolve), `heartbeat`, `openclaw/query`.
     Each: authenticate (`lib/apiAuth`) → permission (`lib/rbac`) → trace api.call →
     data; 401/403/400. **Filters** on traces/anomalies/kpi (`lib/filters` + `lib/timeRange`).
   - **MCP + CLI** (`mcp/`): 6 tools (health, list_traces, get_kpi, list_anomalies,
     report_anomaly, query_openclaw) + CLI; env+bearer; filter params; 36 tests.
   - **Crons** (`crons.ts`): trace purge (daily), kpi rollup (hourly), vendor flush
     (5 min), anomaly detect (5 min).
   - **Admin UI tabs** (`AdminSettings.tsx` + `chat/admin/*`): Users, Groups,
     Instances, Service accounts, Roles (matrix), Traces, KPI, Anomalies,
     Integrations, Theme, Audit. Toast error surfacing (`components/ui/toast`).
   - **Hardening** (`OBSERVABILITY_REVIEW.md`): adversarial review (0 critical, 1
     high, 8 med, 9 low) + fix pass applied (H1, M1–M7, L1–L9, D-2, D-5).
8. **Filters + Grafana time-range** across UI + Convex + `/api/v1` + MCP/CLI.
   `lib/filters.ts` + `lib/timeRange.ts` (relative tokens `now-24h`); per-tab `filter`
   arg; `src/chat/admin/filters/` (TimeRangePicker, FilterBar, AdvancedFilter,
   types). `FILTERS_SPEC.md`. Alias gotchas: anomalies filter key = `anomalyStatus`
   (HTTP `?status=`); service-account `role`→roleKey; Users `role` not aliased;
   traces has both `status`(num) + `statusClass`.
9. **Routing — TanStack Router v1** (`ROUTING_RESEARCH.md`). `App.tsx` +
   `ConvexChatApp.tsx` DELETED; auth shell + chrome now in `src/router.tsx`
   `RootShell` (`<Outlet/>` only for Authenticated + active role). `main.tsx` =
   `ConvexAuthProvider > DialogsProvider > RouterProvider` (+ dev-only router
   devtools, bottom-right). Routes: `/`, `/chat/$chatId`, `/settings/<tab>` (static
   route per filtered tab w/ typed `validateSearch`; shared `/settings/$tab` for
   roles/integrations/instances/theme). Filter/time-range = URL **search params**
   (`lib/routing/searchSchemas.ts`; time-range as TOKENS, resolved component-level;
   `adv` predicates = one JSON param). Impersonation kept: `key={me.userId}` +
   `navigate("/")` on REAL identity change only (deep-link survives login). 20
   round-trip tests.
10. **Global conversation search (topbar ⌘K palette).** Full-text over the
   caller's OWN messages + an in-JS title match → bounded ranked one-row-per-chat,
   deep-links `/chat/$chatId`. Backend: `messages.searchIndex("search_text",
   {searchField:"text", filterFields:["userId"]})` + `convex/search.ts`
   `searchConversations` (effective-user scoped = impersonation-aware like
   `listByChat`; READ ⇒ NOT audited) + pure helpers `convex/lib/search.ts`
   (snippet/title/terms). Frontend: `src/chat/GlobalSearch.tsx` (Dialog palette,
   hand-rolled keyboard nav ↑↓/Enter/Esc, ⌘K/Ctrl-K, 180ms debounce, no cmdk dep),
   wired into `AppTopBar` center (3-zone topbar) + CSS in `convexChat.css`
   (`.oc-search-*`). ACCESS BOUNDARY = `.eq("userId", effectiveUserId)` on the
   message search + title matches sourced only from `by_user`-loaded chats. 10
   tests incl. a `withSearchIndex` smoke + a cross-user no-leak test. **Backend
   LIVE-VERIFIED in the local prod deployment** via a dev-gated `dev.searchProbe`
   (`npx convex run dev:searchProbe '{"term":"…","userId":"…"}'`): the production
   index returns hits AND the `userId` filter scopes (term "hello" → 1 hit for its
   owner, 0 for another user). Only the palette UI is browser-PENDING (§5.1).

---

## 3. Load-bearing invariants (NEVER break)

- **Secrets** (gateway tokens, device identities, `BRIDGE_INGEST_SECRET`,
  `BRIDGE_SHARED_SECRET`, API-key PLAINTEXT, Convex deploy keys, OpenClaw fs paths)
  live ONLY in deployment env / bridge env — NEVER in Convex tables or the browser.
- **Auth**: `ConvexAuthProvider` is the OUTERMOST provider (plain ConvexProvider →
  every `requireUserId` throws). It wraps `RouterProvider`.
- **RBAC**: `ensureProfile` is the single role-writer; first-admin via `appMeta`
  singleton OCC; last-admin guard; `getActor` resolves effective (impersonation)
  only when REAL profile is admin; `requireAdmin` keys off REAL identity (never
  lost while impersonating); every cross-identity action is audited (`auditLog`).
- **PHI (D2)**: traces + anomalies store metadata ONLY (lengths, counts, status,
  latency, kinds, ids) — NEVER message text/attachments/tokens. `writeTraceEvent`
  forces `redacted:true`. RBAC matrix mgmt is admin-only Convex funcs, NEVER `/api/v1` (D4).
- **API keys (D3)**: SHA-256 hash-only at rest, plaintext shown once at mint; mint
  is an ACTION (CSPRNG + hashing are non-deterministic ⇒ illegal in query/mutation).
- **Storage split (D1)**: Convex = bounded recent trace window + KPI rollups; the
  firehose ships to Opik/Langfuse. Retention cron. **Filters operate over the
  bounded recent window — an older `from` returns PARTIAL results** (UI shows a
  "fenêtre récente" hint).
- **Routing**: `<Outlet/>` renders ONLY inside Authenticated + active role; URL
  stores time-range TOKENS (never resolved epochs → no history/subscription spam);
  impersonation = key remount + navigate("/") on real identity change only.
- Schema additions to EXISTING tables must be OPTIONAL (push validates existing rows).

---

## 4. The architecture is the bricks (what won't change)

`lib/` modules are the stable, reusable foundation everything builds on, keep them
the single source: `access` (identity/RBAC), `rbac` (permission matrix), `apikeys`
(crypto), `apiAuth` (key auth for httpActions), `audit`, `filters` + `timeRange`
(filtering), `observability.writeTraceEvent` (single trace writer). Frontend bricks:
`components/ConfirmDialog` (useConfirm/usePrompt), `components/ui/*` (shadcn),
`components/ui/toast`, `chat/admin/DataTableShell` (table + inline expansion),
`chat/admin/EntitySheet` (add/edit Sheet), `chat/admin/filters/*` (FilterBar,
TimeRangePicker, AdvancedFilter), `lib/routing/searchSchemas` (URL contract),
`lib/useTheme` + `lib/useSidebarLayout`. New features should compose these, not fork them.

---

## 5. PENDING / NEXT (prioritized)

### 5.1 Browser verification (do FIRST when chrome-devtools MCP reconnects)
The MCP has been disconnected for a long stretch; everything below is
tsc+build+tests-verified but NOT browser-confirmed. Verify, in dev (:5174):
- **Routing**: sign-in → a deep link (`/chat/$id`, `/settings/traces?from=now-7d&statusClass=5xx`) survives login; open chat → copy URL → refresh → same chat; Back/Forward; `/settings/theme` bookmark; non-admin on `/settings/*` → redirect `/`; a filtered Traces URL refresh restores filters + LIVE range; impersonation start/stop → `/`.
- **Filters UI** on Users/Groups/ServiceAccounts/Traces(+adv)/Anomalies/Audit(+adv)/KPI: search, quick selects (auto-width labels not truncated), TimeRangePicker (relative+absolute), AdvancedFilter numeric predicates.
- **Anomalies tab** resolve/acknowledge; **Integrations tab** status (no secrets); **toast** error surfacing (e.g. demote last admin); **service-account delete** (type-to-confirm cascade); **inline key-card expansion** under its row; **Roles matrix** anti-clobber + seed on fresh deploy; **show-once mint** non-dismissible.
- Theme tab Filtres showcase renders in light+dark.
- **Global search (topbar ⌘K)**: ⌘K/Ctrl-K opens; type ≥2 chars → results; ↑↓ moves highlight, Enter opens the chat, Esc closes; clicking a result deep-links `/chat/$chatId`; title-match rows tagged "Titre" vs message rows tagged "Message" with a snippet; seed a chat with known keywords (`convex/dev.ts` seedChat) and confirm a body-text term surfaces it; centered trigger doesn't overlap brand/UserMenu; renders light+dark; narrow width collapses the trigger to icon-only.

### 5.2 THE major milestone — Bridge worker → modular multi-provider/multi-tenant
**DESIGNED (2026-06-03), Phase-0 decisions CONFIRMED, NOT yet built.** The
`bridge-design` dynamic workflow (16 agents) produced three authoritative docs —
read these FIRST before any bridge work:
- **`docs/BRIDGE_ARCHITECTURE.md`** — the `BridgeProvider` seam (OpenClaw + Hermes
  adapters around the normalized vocabulary), one-connection-per-instance
  multiplexing, the data model + secret-store reconciliation, streaming scope.
- **`docs/OPENCLAW_RESEARCH.md`** — grounded research: OpenClaw IS real
  (`github.com/openclaw/openclaw`, tag **v2026.5.19** verified, docs at
  `docs.openclaw.ai` + in-repo `gateway/protocol.md` v4). HONESTY record: the
  in-repo normalizer + 12 fixtures WIN over the public doc where they diverge
  (the `agent` event family, the `state=delta|final` turn-end machine, the webchat
  sessionKey grammar are fixture-only; the `agent:<id>:subagent:<uuid>` grammar is
  **NOT FOUND** in primary sources → OpenClaw `capabilities.subagents=false` until confirmed).
- **`docs/BRIDGE_IMPLEMENTATION_PLAN.md`** — phased build plan (P1 pure refactor →
  P7 streaming), requirement→phase→gate map. **Phase 0 CONFIRMED: A2 / B1 / C1.**

**Confirmed decisions (irreversible):**
- **A2 streaming** — Convex stays the SOLE browser transport; decouple by making
  persistence cheap: stream into an **un-indexed live field**, reconcile into the
  searchable `messages.text` at finalize. Kills the per-flush amplifiers (O(n²)
  text rewrite + **search-index reindex** + `listByChat` recompute) WITHOUT an
  SSE-per-turn. NB: today the bridge ALREADY coalesces deltas (~50ms,
  `convex-writer.ts`); the problem was display-path == persistence-path, not per-token.
  **A2 was re-challenged (user asked: why not Vercel AI SDK?) and SETTLED — keep
  A2 + assistant-ui, HIGH confidence** (`docs/AISDK_VS_A2_DECISION.md`, 22-agent
  workflow + lead re-verification): AI SDK UI `ChatTransport` has exactly 2
  client-trigger methods, **zero server-push** (verbatim `ai@6.0.196` + beta) →
  structurally can't carry a post-turn-emitting gateway; transport vs render are
  separable so "switch to AI SDK" is a false binary (the familiarity win is
  reachable at the render layer via `@assistant-ui/react-ai-sdk` without ceding
  transport = the documented "hybrid" escape valve). Flip condition: a future AI
  SDK true server-initiated push/subscribe transport + a Convex-backed impl.
- **B1 schema** — new `agents` + `userAgents` tables (M:N, shared, reverse lookup);
  `profiles.allowedInstances` array; `profiles.defaultAgentId` **pointer** (one
  default unrepresentable-to-break); `agents.subagents` array; instance/agent/subagent
  **snapshot fields on `chats`** (pin-at-creation → new-chat instance picker when
  `allowedInstances.length>1`); optional `instances.provider` (default "openclaw").
  All EXISTING-table deltas OPTIONAL.
- **C1 secret store** — mounted secrets file (e.g. `/etc/openclaw-bridge/secrets.json`,
  0400) behind `SecretStore.getGroup(name)`; Image #22 JSON generalized per provider;
  `groups.<name> == instances.name` is the ONLY non-secret token crossing to Convex;
  fs.watch hot-reload; bootstrap secrets stay in env; vault = later loader swap.

**Red-team must-fix carried into the build (do NOT regress):** (1) outbound media =
bridge uploads bytes → Convex File Storage → `messageParts.storageId`; NO OpenClaw fs
path crosses into Convex; (2) subagent sessionKey grammar = NOT FOUND → don't fabricate;
(3) ONE agent-resolution precedence folded into `routing.ts` (don't duplicate
override/group); (4) new-chat instance picker query projects ONLY `{name,displayName}`
for non-admins (no `gatewayUrl`/`publicUrl` to the browser); (5) `verboseFullApplied`
becomes per-sessionKey before one-connection-per-instance fan-out.

**Phase 1 DONE (2026-06-04) — provider seam extracted, pure refactor.** New layout:
`bridge/src/core/{events,provider,turn-sink}.ts` + `bridge/src/providers/openclaw/
{openclaw-client,normalizer,sanitize,session-keys,run-manager}.ts`. The monolithic
`RunManager` was split: the OpenClaw **driver** (`providers/openclaw/run-manager.ts`
= Normalizer + TurnSink, unchanged public API used by `session.ts` + tests) and the
provider-agnostic **`TurnSink`** (`core/turn-sink.ts` = the `apply()` switch +
finalize buffer → ConvexWriter). The 7 `EVENT_*` constants + `NormalizedEvent`/
`BridgeEvent` moved to `core/events.ts` (re-exported from the normalizer for
back-compat). `core/provider.ts` = the `BridgeProvider` interface (P1 contract; the
OpenClaw adapter implementing it = P2). Added `bridge/vitest.config.ts` (node env) —
the bridge had none, so `npm test` was silently picking the root edge-runtime config.
**Gate met:** bridge tsc 0; **31/31 bridge tests byte-green** (23 normalizer + 8
run-manager = zero behavior change); tsc src+convex 0; root vitest 97; mcp 36; `core/`
imports zero OpenClaw code. `git mv` preserved history (staged, NOT committed — user commits).

**Connection model RESEARCHED + SETTLED (2026-06-04) → Model A** (one operator WS
per instance, multiplexed). See `docs/OPENCLAW_CONNECTION_MODEL.md` (primary-source,
v2026.5.19 raw docs + adversarial verify). Native per protocol.md: "each client
connection keeps its own per-client sequence number … scope-filtered subsets of the
event stream"; `sessions.subscribe`/`sessions.messages.subscribe` are per-session on
ONE WS client; `chat.send` addresses a conversation by an in-message `sessionId`
param, not by socket. Pairing is durable per device (`~/.openclaw/nodes/paired.json`,
token rotates on re-pair) → the device IS the connection identity (confirms the
per-instance read). **Model A uses exactly ONE connection per instance, so it is
correct regardless of the deciding unknown.**
- **DECIDER UNKNOWN (live-only, T2):** whether two concurrent SAME-ROLE operator
  connections may share one device identity is NOT documented (no "device already
  connected"/displacement rule). Only CROSS-role (operator+node) coexistence is
  verbatim. Doesn't block A; matters operationally (the bridge's device identity must
  not contend with the user's existing operator clients → prefer a DEDICATED paired
  bridge device).
- **🔒 NEW LOAD-BEARING INVARIANT — the Gateway is NOT per-user isolation.** Session
  content gates on the `operator.read` SCOPE, not per-user identity (operator-scopes.md:
  "not hostile multi-tenant isolation … run separate Gateways under separate OS users
  or hosts"). The bridge holds ONE operator connection seeing ALL sessions on that
  gateway. Therefore the **BRIDGE is the trusted demux point and MUST enforce per-user
  isolation** (sessionKey→chatId→owner routing + Convex ownership checks). A cross-user
  routing bug = a PHI leak. (Note: Image #22 already separates groups by GATEWAY —
  admin vs family — so isolation is needed BETWEEN users sharing one group's gateway.)
- **sessionKey grammar residual (T4):** docs show `agent:<agentId>:<mainKey>`; the
  bridge's fixture form `agent:<agentId>:webchat:chat:<canonical>:<chatId>`
  (`session-keys.ts`) is **NOT FOUND** in v2026.5.19 docs — must be captured from a real
  webchat session before/at first live send, or `chat.send` may target a wrong session.

**DEV/PROD INSTANCE STRATEGY (user decision 2026-06-04):** the bridge gets a
DEDICATED dev pairing on the **`olivier`** instance (`gateway.lacneu.com`, group
`admin`, reachable from the LAN). This is the per-version empirical regression bench:
on every new OpenClaw/Hermes version, run the full live feature suite against `olivier`
FIRST to catch regressions BEFORE touching the **`jerome`** instance (group `family`,
`ataraxis.lacneu.com` = the protected one). This is how multi-version support (out of
the design workflow's scope) is handled operationally. Pairing is per-device (Q5):
generate a fresh device keypair → `node.pair.request` → admin approval issues a token →
reconnect with the token (signing the `connect.challenge` nonce).

**🟢 FIRST LIVE ROUND-TRIP GREEN (2026-06-04) — F1 (text send → stream → final →
persist) WORKS against the real gateway.** The full chain is proven live via the
LEGACY single-chat path (`session.ts` SessionRegistry — untouched by P1): connect
(device identity + token + `wss://gateway.lacneu.com`) → `sessions.patch{verboseLevel:full}`
→ `chat.send` (ack ok) → the agent streams → normalizer → ConvexWriter → `messages`
row status **complete** ("Bridge validé, je te reçois bien."). CAPTURED LIVE GROUND TRUTH:
- **`server.version = "2026.5.19"`**, protocol 4 (the harness's VERSION ORACLE, in hello-ok
  under `frame.payload.server`); hello-ok also lists the full `features.methods` RPC set.
- **sessionKey `agent:olivier:webchat:chat:olivier:<convexChatId>` is ACCEPTED** → T4 RESOLVED;
  `session-keys.ts` is correct (the "NOT FOUND in docs" was a doc gap, not a bug).
- **Two inbound frame families confirmed**: `agent` (`stream:lifecycle|assistant`, `data.delta`)
  AND `chat` (`state:delta|final`, `deltaText`, `message.content[].text`); the normalizer handles
  both. `lifecycle:end` carries `livenessState` (saw "working"). The chat.send ack carries NO
  runId — it arrives in the frames (`webchat-<hash>`); frames were admitted regardless.
- The OWUI contention (T2) did NOT block the connect (one success; not conclusive).

**AUTONOMOUS LIVE PROGRESS (2026-06-04, after the features+matrix workflow + its
30-feature `docs/LIVE_TEST_MATRIX.md` + the 8 red-team must-fix blockers):**
- ✅ **Guardrail (red-team #8): olivier-only is CODE-LOCKED** — `dev.routeUser`/`dev.testSend`
  refuse any instance outside the allowlist `["admin"]` (never jerome/family).
- ✅ **F-PARALLEL-CONVO GREEN live** — one user, two parallel chats ("ALPHA"/"BRAVO") each
  finalized in its OWN conversation, zero cross-talk (legacy per-chat-socket path isolates,
  as the red-team predicted; the multiplexer is for the multi-USER case, still unwired).
- ✅ **F-COMPACT-MANUAL GREEN live** — `/compact` IS a real command → a NORMAL turn (3 `chat`
  `state:final`, snapshot-replaces) → reply "⚙️ Compacted (58k/200k)" persisted correctly. NO
  `livenessState`/abandon/`sessions.operation` frame. FINDING: the normalizer's discard key
  `livenessState==='abandoned'` (red-team #2) is specific to AUTO-compaction mid-turn (context
  overflow), NOT manual /compact — capturing it needs a deliberate ~200k-token overflow run
  (DEFERRED, expensive; manual compaction already handled correctly).
- ✅ **A2 streaming IMPLEMENTED + LIVE-VERIFIED (red-team #1 RESOLVED).** Schema: new OPTIONAL
  un-indexed `messages.liveText`. `stream.ts`: `appendDelta`/`setSnapshot` patch `liveText`
  (NOT `text`) during the turn; `finalize` writes the authoritative text into the searchable
  `text` ONCE + clears `liveText`. `messages.listByChat` returns `liveText` while streaming,
  `text` when done (no frontend change). Live: mid-stream `text=""`/`liveText` grows; final
  `text="…Test validé."`, search still finds it. The per-flush search-reindex amplifier is gone.
  Gates: tsc convex+src 0, vitest 97. **BROWSER-VERIFIED (chrome-devtools, 2026-06-04):**
  sent a message from the real UI → the assistant reply **streamed and rendered**
  ("Le flux s'affiche bien…") via the A2 liveText path; a **"Running" + runId processing
  marker** shows during the turn (F-MARKER-PROCESSING base already present). Full stack
  proven visually: UI → Convex → bridge → gateway → stream → A2 persist → reactive render.
  Evidence: `docs/live-evidence-F1-A2-browser.png`. (chrome-devtools MCP reconnected; the
  orphaned-Chrome-profile lock is cleared by killing the `chrome-devtools-mcp/chrome-profile`
  procs. Test gotcha: the browser opens a FRESH anon user = "pending" → promote via
  `dev.makeAdmin {canonical:"u-<id>"}` + `dev.routeUser`; UI `fill` doesn't trip React state,
  use `type_text`+Enter or drive sends via `dev.testSend` and verify render in the browser.)
- ✅ **F-TOOL-TOGGLE GREEN (browser-verified).** Tool cards render + a per-user "show tools"
  preference toggled FROM THE CHAT (composer button) hides/shows them; the pref persists
  reactively. New: `profiles.showTools` (optional) + `me.getMe.showTools` + `me.setShowTools`;
  `ConvexChat` reads it, adds `.oc-hide-tools` (CSS hides `.oc-tool`), toggle in the Composer.
  **LIVE TOOL-FRAME DIVERGENCE FOUND + FIXED** (the harness's whole point): v2026.5.19 emits
  tool activity as `agent` `stream:"tool"` (phase start{args} / result{result,isError}) +
  `stream:"item"` — NOT the fixture `session.tool` shape. `normalizer.handleTool` now COALESCES
  a real tool's start(args)+result(result) into ONE `completed`/`error` `tool.status` carrying
  input+output (buffered by `toolCallId` in a new `toolArgs` map; cleared per turn); the
  message-tool visible-reply path + media-collection-from-result are unchanged. `turn-sink`
  forwards input/output onto the `ToolPart`. Browser: ONE clean web_search card, phase
  "completed", input+output disclosures (searxng results incl. the `EXTERNAL_UNTRUSTED_CONTENT`
  wrapping). 36 bridge tests stay byte-green (fixtures only have message-tools).
- NEW dev tooling: `dev.inspectChat({chatId})` (clean harness oracle: latest messages + part
  kinds/names/phases + A2 text/liveText lengths); `dev.testSend` is now chat-aware (sends as the
  chat's owner when a chatId is given). Two admin profiles now exist (kh74bs "olivier" + the
  browser's kh77jp16fe), both routed to "admin".
- 🔑 **FULL GATEWAY METHOD MAP CAPTURED (189 methods, from hello-ok features.methods; the
  `dbg` hello-ok clip is bumped to 20000 to log it).** This UNBLOCKS the heavy features:
  - **Media outbound is NOT topology-blocked**: `artifacts.list` / `artifacts.get` /
    `artifacts.download` EXIST → the bridge fetches file BYTES over the WS (no need to read the
    gateway's remote filesystem). Plan (F-FILEOUT-ARTIFACT): after a turn, `artifacts.list({sessionKey})`
    → `artifacts.download` new ones → Convex File Storage (an ACTION: `ctx.storage.store`) →
    `messageParts.storageId` → MediaPart render. FINDING: a file the agent writes via `exec` to
    `/home/node/.openclaw/media/outbound/<name>---<uuid>.md` does NOT auto-emit a `media` event
    (only `mediaUrls`/`MEDIA:` directives do), so the artifacts-poll path is the robust one.
  - **Archived recovery**: `chat.history` exists (F-RECON). **Conversation list**: `sessions.list`,
    `sessions.describe`, `sessions.preview`. **Compaction recovery**: `sessions.compact`,
    `sessions.compaction.branch|get|list|restore` (the "OpenClaw context == webchat view" requirement).
    Event families: `session.message|operation|tool`. Tools confirmed as `agent stream:"tool"` live.
- 🛑 **MEDIA-OUTBOUND ROOT CAUSE TRAPPED (2026-06-05) — user-reported: file attaches in OpenWebUI
  but is INVISIBLE in our webchat.** Precisely diagnosed live (probes `bridge/dev-probe-artifacts.mjs`
  + `dev-probe-files.mjs`): an agent-produced file lands at `/home/node/.openclaw/media/outbound/
  <name>---<uuid>.md` ON THE GATEWAY HOST and is (a) NOT pushed in the chat stream (no `media`/
  `mediaUrls`/`MEDIA:` frame; the final `chat` content is text-only "Fichier créé et joint."),
  (b) NOT a queryable artifact (`artifacts.list({sessionKey})`=`{artifacts:[]}`; `{runId}`="no
  session"; artifacts need a LIVE session + explicit registration), (c) NOT served by `agents.files.*`
  (that only serves the agent's CONFIG workspace: AGENTS.md/SOUL.md/MEMORY.md — `get` rejects the
  outbound file: "unsupported file"). So the ONLY delivery is OpenClaw's LOCAL `media/outbound/`
  filesystem convention, read by a CO-LOCATED client (the OWUI valve runs on the OpenClaw host).
  Our bridge runs REMOTELY (Olivier's Mac) → it cannot read that dir → no attachment reaches the
  webchat. Also a SECONDARY bug: `normalizer.collectMedia` only matches a candidate string that IS
  itself an outbound path; a path EMBEDDED in multi-line `exec` output is missed. **RESOLUTION =
  a DEPLOYMENT/topology DECISION (pending user):** (A) co-locate the bridge on the OpenClaw host
  (reads `mediaOutboundDir` directly → `ctx.storage.store` → messagePart; the original design's
  `OPENCLAW_MEDIA_OUTBOUND_DIR`), or (B) remote-fetch the bytes via `exec`/`node.invoke` base64 over
  the WS (works from the Mac but uses exec → `exec.approval.*` gating + is a workaround). F-FILEIN
  (user→agent) is separate and may work over `chat.send.attachments` (Convex storage → base64).
  **Investigation C (user chose "find a clean native remote RPC") — DEFINITIVE VERDICT 2026-06-05:
  NO native remote byte-fetch exists for outbound media on the OpenClaw gateway v2026.5.19.** Proof:
  (1) `chat.history({sessionKey})` (durable JSONL) returns the file PATH (via the `MEDIA:` directive)
  but NOT bytes. (2) `gateway.lacneu.com/{media,files,artifacts}/outbound/<f>` → 200 but it's the
  **SPA catch-all** (body = "OpenClaw Control" HTML; a bogus name 200s too) — not a file route.
  (3) `gateway.lacneu.com/api/media/outbound/<f>` → **404 even WITH `Authorization: Bearer`**; ALL
  `/api/*` (incl. `/api/health`, `/api/version`) → 404 → the gateway has NO `/api/*` router. Its
  HTTP surface = `/health` (JSON `{ok,status:live}`) + WS + SPA. (4) `artifacts.list` empty,
  `agents.files.*` config-only. **The proven working mechanism (the OWUI valve = old bridge backend,
  documented in OUR OWN `docs/BRIDGE_PROTOCOL.md` + `docs/DEPLOYMENT.md`):** the BRIDGE/backend mounts
  the OpenClaw `media/outbound` dir **read-only** (`…/media/outbound:/home/node/.openclaw/media/
  outbound:ro`), reads bytes from `OPENCLAW_MEDIA_OUTBOUND_DIR`, and serves them via a signed
  `GET /api/media/outbound/{filename}` (HMAC `OPENCLAW_MEDIA_LINK_SECRET`). Path from the stream /
  `chat.history` (`MEDIA:` directive); **bytes from the mounted FS, NOT the gateway.** => **Option A
  (co-location / shared `:ro` volume) is REQUIRED for prod.** Chosen modular design: a pluggable
  per-instance `MediaFetcher` with strategies `localDir` (prod, mount — matches our docs) + `exec`
  (dev/fallback: WS exec runs server-side on the gateway host → `base64 media/outbound/<f>` → bytes
  over the WS, works from the non-co-located Mac dev bridge, `exec.approval.*` auto-approved on
  olivier). The normalizer already emits `media{items:[{filename,path}]}`; the writer's `addMedia`
  already assumes a local `mediaOutboundDir` (= the mount). Wire: media event →
  MediaFetcher(strategy).bytes(path) → `ctx.storage.store` → `messageParts{kind:media,storageId}` →
  frontend render. Also fix the SECONDARY `collectMedia` bug (parse `MEDIA:`/paths from multi-line
  exec output). Probes: `bridge/dev-probe-artifacts.mjs`, `dev-probe-files.mjs`.
  **F-FILEOUT — IMPLEMENTED + PROVEN LIVE 2026-06-05.** Three bugs were in the chain; all fixed:
  (1) EXTRACTION (`normalizer.ts`): the exec-produced path lives ONLY in the tool RESULT (a
  `MEDIA:/home/node/.../outbound/<f>` line in stdout) — never in `mediaUrls` nor the visible reply.
  `collectMedia` required each candidate to BE a bare path AND only ran for object/array results, so
  a path buried in multi-line stdout was dropped → NO media event. Fixed: scan every result string
  (incl. plain strings) for embedded outbound paths via `EMBEDDED_OUTBOUND_RE`, each re-validated by
  `isOutboundMediaPath` (the `..`/inbound/scheme safety gate is preserved). New normalizer test +
  inspectChat confirmed the live exec turn had only `read,exec,exec` parts and NO media before the
  fix. (2) FETCH (Option B, no remote RPC exists): new `bridge/src/core/media-fetcher.ts`
  (`MediaFetcher` interface + `LocalDirMediaFetcher`) reads bytes from `mediaOutboundDir`;
  `HttpConvexWriter.addMedia` now fetches bytes + ships base64 via the new `addMediaBlob` ingest op
  (the dead `OPENCLAW_MEDIA_BASE_URL` fetch in `convex/bridge_ingest.ts` is replaced —
  decode→`ctx.storage.store`→`addPart{kind:media}`). The `ConvexWriter.addMedia` INTERFACE is
  unchanged (fake + tests intact). 20MB cap (`OPENCLAW_MEDIA_MAX_MB`). (3) RENDER (`MediaPart.tsx`):
  assistant-ui renders `<File {...part} />` (fields SPREAD, NOT `{part}` — same as ToolCard); the old
  `{part}` destructure made `part.mimeType` throw and crashed the whole message ("Cannot read
  properties of undefined (reading 'mimeType')"). Fixed to destructure spread fields. PROOF: 41
  bridge tests + frontend/convex tsc green; live `bridge/dev-prove-media.mjs` drove the REAL
  writer→fetcher→ingest→storage→part on chat jx7f3yr (fixture dir, NO gateway needed) → browser
  rendered a downloadable `preuve-media---demo.md` link → its Convex storage URL returns the exact
  294-byte markdown (screenshot docs/live-evidence-FILEOUT-mediapart.png).
  **ONE INFRA STEP REMAINS for REAL agent files on the DEV bench:** the bridge runs on the Mac but
  the gateway writes to gateway.lacneu.com's `media/outbound`; until that dir is mounted/synced into
  the bridge (`OPENCLAW_MEDIA_OUTBOUND_DIR`), `LocalDirMediaFetcher` logs "skip <f>: not found" for
  real agent files. Prod = the documented `:ro` volume mount; dev = SSHFS/rsync of the gateway dir.
  Extraction (bug 1) + render (bug 3) work regardless; only the byte read needs the mount.
  **LIVE-CONFIRMED 2026-06-05 (the advisor's decisive check):** drove a real `animaux.md` creation
  turn on chat jx7f3yr with the new bridge + BRIDGE_DEBUG. The real `agent stream:"tool"` exec
  RESULT frame carried the ABSOLUTE path `/home/node/.openclaw/media/outbound/animaux---2e463a80-…md`
  (so `EMBEDDED_OUTBOUND_RE`'s `/home/node/.openclaw/media/outbound/` prefix DOES match real output —
  not relative, directive not stripped), and the bridge logged `[media] skip animaux---2e463a80-…md:
  not found` — which can ONLY appear if the normalizer extracted the path from the LIVE frame and
  called the fetcher. => bug #1 fires on real frames; the `not found` is the unmounted dir, the sole
  remaining gap. To finish on the dev bench: `sshfs <gateway>:/home/node/.openclaw/media/outbound
  <local> && OPENCLAW_MEDIA_OUTBOUND_DIR=<local>` (or rsync), then real agent files render too.
  **TRANSFER UPGRADE 2026-06-05 (base64 → streaming, see docs/MEDIA_TRANSFER_DESIGN.md):** the
  bridge→Convex hop was base64-in-httpAction (`addMediaBlob`, capped at the 20MB httpAction body +
  ~33% inflation). Replaced with the Convex upload-URL pattern: ops `getUploadUrl`
  (`ctx.storage.generateUploadUrl()`) + `addMediaPart`; `HttpConvexWriter.addMedia` now STREAMS raw
  bytes (`Readable.toWeb`, `duplex:"half"`) straight to the upload URL (no base64, no size ceiling,
  no full buffer) then persists the storageId. `MediaFetcher.open()` returns a `{stream,mimeType,
  size}` (was `{bytes}`). Cap raised to 1GiB (`OPENCLAW_MEDIA_MAX_MB`, just a guard now). Proven
  live: a 5 MiB binary streamed byte-exact (5242880 bytes) past the old 20MB ceiling. Community
  research (in MEDIA_TRANSFER_DESIGN.md) confirms this matches the declined upstream proposal #11769
  + base64 DoS advisory GHSA-w2cg-vxx6-5xjg. The Leg-1 plugin (drop the mount) remains a user
  decision pending a streaming/range/fs spike of `api.registerHttpRoute`.
- **LOCAL EPHEMERAL OPENCLAW HARNESS — BUILT + #52 LOCAL VALIDATED 2026-06-05 (task #55).** User
  refused SSHFS (NAS SSH port closed); chose a local volatile OpenClaw the agent starts/stops itself,
  pristine each run, version-pinned, based on the NAS image. Built `local-openclaw/`:
  `docker-compose.yml` (image `neuolivier/openclaw-docker:openclaw-${OPENCLAW_VERSION:-2026.5.19}`,
  token auth, ephemeral `oc-state` volume, **host-bind `./media-outbound` shared with a Mac bridge**)
  + `up.sh`/`down.sh`/`reset.sh`/`pair.sh` + README + `.gitignore`. KEY LEARNINGS: entrypoint =
  `gateway --allow-unconfigured --bind=lan`; a LAN-bound container **refuses `--auth none`** (loopback
  bind is incompatible with docker port-forward) → **token auth + device pairing required**; token
  alone = `NOT_PAIRED`; `pair.sh` registers the bridge's Ed25519 device (throwaway connect) then
  `devices approve <requestId> --token` (CLI: `devices list --json|approve|clear`). Gateway healthy
  ~15s (amd64 image emulated on arm64). **#52 LOCAL PROVEN END-TO-END:** the gateway CONTAINER wrote
  `rapport-local---<uuid>.md` → host bind saw it → bridge streamed it to Convex → rendered byte-exact
  in the webchat (docs/live-evidence-52-local-gateway-share.png). **THE ONE INPUT STILL NEEDED for
  model-driven agent turns:** a pristine gateway has NO agent/model (`defaultAgent:(none)`); the NAS
  agent uses `openai-codex` via OAuth (creds not portable). Put a model key (`OPENROUTER_API_KEY`) in
  `local-openclaw/local.env` + wire the agent (openclaw.json / `onboard`) to run real turns; until
  then the media-share is validated via docker-exec-write (no model). Gateway currently STOPPED to
  save resources during the user's absence (state+token kept; `cd local-openclaw && ./up.sh` restores
  in ~20s; emulated amd64 image is heavy on arm64). PRISTINE CYCLE VERIFIED across
  2× `reset→up` (fresh volume + new token + new pairing requestId each time → bridge reconnects).
  KEY-READY SEED ATTEMPT: a minimal hand-written `seed/openclaw.json` was REJECTED at boot
  (`<root>: Invalid input` — schema needs ~18 sections like the 12KB olivier seed), so the
  `oc-seed` init is COMMENTED OUT in the compose and the file kept as `seed/openclaw.json.example`;
  to wire an agent run `docker exec -it oc-local-gateway node /app/openclaw.mjs onboard` (writes a
  valid config) + drop `OPENROUTER_API_KEY` in `local.env`. Agent id MUST be `olivier` (= bridge
  `OPENCLAW_AGENT_ID`).
  **CODEX HARNESS MODE — VALIDATED + CODIFIED 2026-06-05 (free local agent turns on the user's
  ChatGPT Pro, no OpenAI API auth, no pay-per-token).** User clarified: NAS = codex API mode; LOCAL
  should = codex HARNESS mode (OpenClaw spawns the local codex app-server reusing `~/.codex` login).
  Validated: an agent turn responded "bonjour"/"harness ok" via the codex harness. The recipe (now
  in `local-openclaw/`): (1) inject `~/.codex/auth.json` → volume `.openclaw/.codex/auth.json`
  (node-owned COPY, not bind — a bind made `.codex` root-owned + broke the entrypoint's config.toml);
  (2) seed `seed/openclaw.json` = the NAS olivier config STRIPPED of plugins/channels/mcp/bindings/
  messages + personal identityLinks (the full seed fails: `plugins.slots.memory: hindsight-openclaw
  not found`; a minimal hand-written one fails the schema) → agent `olivier`, model `openai/gpt-5.5`,
  codex runtime; (3) env `OPENCLAW_CODEX_APP_SERVER_BIN=/usr/local/bin/codex-yolo-wrapper.sh` + a
  bind-mounted `codex-yolo-wrapper.sh` that REORDERS `--dangerously-bypass-approvals-and-sandbox` to
  a GLOBAL position (OpenClaw 2026.5.19 appends it AFTER `app-server`; codex 0.133 wants it BEFORE the
  subcommand → "unexpected argument" otherwise; native fix expected >=2026.5.20). `up.sh` does (1)+(2)
  conditionally after boot then restarts. NOTE: the local codex login is account `xavier@jodoin.me`
  (Pro) — turns consume THAT account. NOT yet done: full bridge→webchat→codex→real-file end-to-end
  (the ultimate #52 + live-test proof). **SECURITY SLIP this session:** a `~/.codex/auth.json` dump
  leaked the OAuth tokens into the transcript (improper nested-dict redaction); advised the user to
  `codex logout && codex login` to rotate if sensitive.
  **FULL LIVE CHAIN VALIDATED 2026-06-05 (#52 CLOSED locally):** ran a 2nd bridge on :8787 against
  the LOCAL gateway (`OPENCLAW_GATEWAY_URL=ws://127.0.0.1:18789`, local token, shared media dir;
  NAS bridge stopped; `BRIDGE_URL` already :8787). `dev.testSend` a file-creation prompt → dispatch
  → local bridge → local codex agent (user's ChatGPT Pro) → the agent wrote `fruits-codex.md` to
  media/outbound + emitted `MEDIA:/home/node/.openclaw/media/outbound/fruits-codex.md` → the bridge
  extracted the media event, read the file via the shared docker bind, streamed to Convex storage →
  the attachment RENDERED + downloaded byte-exact (26B, text/markdown). Screenshot
  docs/live-evidence-52-codex-fullchain.png. **KEY LEARNING (the precise dysfunction, trapped):** the
  attachment renders ONLY when the agent emits a `MEDIA:` directive. With codex's default flow
  (`apply_patch` to the workspace + "joint" in prose, NO directive) OpenClaw auto-copies the file to
  media/outbound as `<name>---<uuid>.ext` but DOES NOT surface that path anywhere (not the operator
  `agent`/`chat` stream, NOT `chat.history` — both only carry the bare "test-codex.md" text) → the
  bridge cannot extract it → no attachment. So reliable attachments need the agent to emit `MEDIA:`
  (the NAS `write-md-file` skill does this automatically; the stripped local seed lacks it → prompt
  it or install the skill). This is an OpenClaw surfacing behavior, NOT a bridge bug — our extract→
  read→stream→render path is proven byte-exact when `MEDIA:` is present. MINOR POLISH: the `MEDIA:`
  line in the VISIBLE reply is also sanitized into a DEAD markdown link (`./media/<f>`) → a duplicate
  next to the working media part; clean up in sanitize.ts (drop the MEDIA: line from visible text, or
  point it at the storage part). CURRENT STATE: local gateway UP, local bridge on :8787, NAS bridge
  stopped — to restore NAS, restart `bridge` (npm start) against the NAS env.
  **OUTBOUND-MEDIA DEDUP FIX + VERSION-AWARE 2026.6.1 TEST 2026-06-05 (#57 cosmetic + #56):**
  (1) DEDUP: the `MEDIA:` directive in the VISIBLE reply was sanitized into a DEAD `./media/<f>`
  markdown link next to the working media part. Fixed: `sanitize.ts` now DROPS a well-formed `MEDIA:`
  directive line (the media part is canonical), and `normalizer.applyVisible` now scans the RAW
  candidate via `collectMedia([candidate])` so a `MEDIA:` in the visible reply STILL emits the
  attachment (dedup'd). 41 bridge tests green (media-directive test updated). Live-verified:
  `parts:[tool,tool,tool,media,tool,tool]` = ONE media part, text clean, no dead link.
  (2) VERSION-AWARE (docs/OPENCLAW_VERSION_COMPAT.md): tested 2026.6.1 (codex 0.137 vs 5.19's 0.133).
  The stripped seed VALIDATES on both; 6.1 has the NATIVE codex-flag fix (bare codex works) while
  5.19 needs the reorder wrapper; crucially the **reorder wrapper is VERSION-AGNOSTIC** (turn
  `wrapper-61-ok` on 6.1) → the harness applies it always, NO per-version branch. So
  `OPENCLAW_VERSION=2026.6.1 ./local-openclaw/up.sh` works unchanged. Per-version replay checklist in
  the doc. STILL OPEN for "all file-exchange complexity": the file-TYPE matrix (pdf/docx/pptx/xlsx/
  images: byte-exact + mimeType + inline-image vs download) — #57; inbound (user→agent,
  chat.send.attachments) — #57; and the NAS config guarantee (#58).
  **PER-VERSION SMOKE TEST + INBOUND TRIAGE + NAS CHECKLIST 2026-06-05 (user: "all implementations
  test BOTH versions"):** (1) `local-openclaw/test-fileexchange.sh <version>` is the per-version
  deliverable — reset → `OPENCLAW_VERSION=<v> up.sh` → restart local bridge on :8787 → MEDIA: prompt
  → asserts ONE media part + byte-exact download + no dead `./media` link (via new dev query
  `dev.lastMediaPart`). Run it on each bump (5.19 + 6.1). (2) INBOUND (user→agent) is **HALF-BUILT =
  a BUILD task, NOT a test task** (advisor triage): the frontend `attachmentAdapter` (upload →
  `uploads.registerUpload` → `{storageId,filename,mimeType}`) + `send.sendMessage({attachments})` +
  outbox `attachmentIds` + dispatch (`convex/bridge.ts` → `attachments: row.attachmentIds`) + bridge
  `server.ts` (`params.attachments = body.attachments` → chat.send) ALL exist, BUT **nobody resolves
  storageId → base64**: OpenClaw receives opaque Convex storage IDs it can't read. THE GAP: the
  dispatch internalAction (has `ctx.storage`) must resolve each attachmentId → bytes → base64 → the
  chat.send.attachment shape (dual: flat `{type,mimeType,fileName,content}` OR
  `{source:{type:base64,media_type,data}}`; offload >2MB to `media://inbound/<id>`) before POSTing.
  Surfaced, NOT built (avoid rabbit hole). (3) NAS = `docs/NAS_CONFIG_CHECKLIST.md` (artifacts +
  commands, UNVERIFIED — can't drive the NAS; API-mode `MEDIA:` surfacing equivalence marked an
  ASSUMPTION to confirm on the NAS). #58 NOT marked complete.
  **SMOKE TEST PASSES ON BOTH VERSIONS + TYPE MATRIX 2026-06-05:** after bumping
  `CONNECT_TIMEOUT_MS` 10s→30s (a cold-start/emulated-amd64 gateway needs >10s for the WS device
  handshake; 10s dropped the first message after a restart) + a 20s settle in the script,
  `test-fileexchange.sh` PASSES for BOTH 2026.5.19 AND 2026.6.1: `✅ 1 media part, no dead link,
  byte-exact 23B, mime=text/markdown`. The 6.1 OUTBOUND gap is CLOSED. TYPE MATRIX: mimeType
  inference unit-tested across md/txt/csv/json/pdf/png/jpg/gif/webp/svg/mp3/wav/mp4/webm/mov/docx/
  pptx/xlsx/zip/unknown (`media-fetcher.test.ts`, 42 bridge tests green); render variants
  live-verified (docs/live-evidence-57-typematrix-render.png): PNG→inline `<img>`, PDF→download link,
  WAV→`<audio>` player. So OUTBOUND file exchange + cosmetic + type matrix = DONE on both versions.
  REMAINING: inbound (build task #59). TRANSIENT NOTE: codex occasionally errors a turn AFTER
  producing the attachment (`codex app-server client closed before turn completed`) — the media part
  still renders; status goes `error`. A codex-runtime blip (emulated), not a bridge bug; worth a
  reconnect/robustness pass if it recurs on the NAS.
  **VERSION STABILITY LEDGER + REPEATED TEST 2026-06-05 (#60, docs/OPENCLAW_VERSION_STABILITY.md):**
  the user wants per-version stability tracked as the basis for TRUSTING a version before promoting
  it. Built `local-openclaw/test-stability.sh <version> <N>` + dev queries `dev.chatStats`
  (last turn role/status/error/created) and `dev.lastMediaPart` (now also returns status). KEY
  METHODOLOGY FIX: the first draft measured *attachment presence*, which CONFLATED app-server
  stability with the agent's inconsistent `MEDIA:` emission (codex sometimes omits the directive even
  when explicitly prompted — a separate reliability axis); switched to **turn terminal status** which
  isolates app-server stability. RESULT (8 turns/version): **2026.5.19 → 8/8 complete, 0 error**;
  **2026.6.1 → 8/8 complete, 0 error.** Both FULLY STABLE in this run → the earlier
  `codex app-server client closed` on 5.19 was a SINGLE intermittent anomaly, NOT reproduced, NOT a
  confirmed per-version defect (corrected the over-claim). Caveat: emulated amd64-on-arm64 — RELATIVE
  comparison trustworthy, absolute may differ from the NAS. The ledger has a promotion-decision
  checklist + an observations log to append per version. Separate reliability axis to track later:
  codex `MEDIA:`-directive compliance (intermittent omission → intermittent attachment loss).
  **#59 INBOUND BUILT + PROVEN ON 6.1 (2026-06-05):** the GAP above is CLOSED. Resolution lives in
  the dispatch internalAction (`convex/bridge.ts`): for each `row.attachments[]` it does
  `ctx.storage.get(storageId)` → `arrayBuffer()` → chunked `btoa` (`arrayBufferToBase64`, default
  action runtime, no Node Buffer) → `{type:"file",mimeType,fileName,content}` (the flat shape the
  live gateway probe ACCEPTED + offloaded to `media/inbound`), capped `INBOUND_MAX_BYTES`=20 MiB
  (under the ~25 MiB WS `maxPayload`), per-attachment try/catch so a bad blob never fails the text
  send. ADDITIVE schema: `outbox.attachments?: {storageId,filename,mimeType}[]` (kept `attachmentIds`);
  `send.sendMessage` populates BOTH; the dispatch body now sends `attachments: resolvedAttachments`
  (was the opaque `row.attachmentIds`). PROOF (real production path, not a mock — exercises the actual
  `internal.bridge.dispatch` on a real outbox row): new dev helpers `dev.seedImageAttachment` (action:
  `storage.store(blob)` from base64) + `dev.enqueueAttachmentTurn` (inserts the SAME outbox row shape
  send.sendMessage builds + a `file` messagePart + schedules the SAME dispatch) + `dev.outboxStatus`.
  Round-trip on **2026.6.1**: uploaded a 96×96 red square (`carre-rouge.png`, 199 B) → agent (codex
  vision, gpt-5.5) replied **"Rouge"**; outbox `status:sent`, `attachmentCount:1`. Both discriminating
  checks hold (bytes reached the agent's vision via media/inbound + outbox terminal-sent). Browser also
  renders the user's image inline (`docs/live-evidence-59-inbound-61-rouge.png`). The media/inbound
  EACCES (the `media/outbound` bind makes `/home/node/.openclaw/media` root-owned so node can't mkdir
  `media/inbound`) is fixed in `up.sh` (chown media node-owned) — re-verified node-writable on the live
  6.1 container before the test, so the vision hit is real, not a perms artifact. **GAP (frontend, NOT
  #59 backend):** the assistant-ui attach widget (`ComposerPrimitive.AddAttachment`/`Attachments` +
  adapter, ConvexChat.tsx:154-157/:96) is wired correctly but NOT verified via automation — CDP
  `upload_file` cannot drive its file picker (no `add()` fires, no chip). Needs a 10-second human
  drag-drop test at the checkpoint. **5.19 ROUND-TRIP BLOCKED by a HARNESS BRING-UP REGRESSION (NOT
  by #59 code, NOT version-specific) 2026-06-05:** trying to re-run on 5.19 surfaced that EVERY
  `bridge /send` (attachment AND plain text-only `dev.testSend`) on a freshly `reset → up → pair.sh →
  bridge-restart`'d container fails with `unauthorized: gateway token mismatch (set gateway.remote.token
  to match gateway.auth.token)` — even though ALL 5 token values hash-match (`dc0ece750a7f`) and
  hand-patching `gateway.remote.token`+restart didn't fix it. **Confirmed version-INDEPENDENT:** a fresh
  `reset → up 2026.6.1` via the SAME scripts fails IDENTICALLY. So the #59 "Rouge" proof + the
  smoke/stability numbers were on gateway containers brought up BEFORE this session (device already
  paired at full scope in persisted state) — they STAND, but are not reproducible via the current
  bring-up cycle. Leading (unconfirmed) hypothesis: `pair.sh`'s `devices approve` grants only
  `operator.pairing` scope while a send needs the `operator.admin` upgrade, which the gateway refuses
  (log: `scopesTo=operator.admin … connect failed 1008`). Full honest write-up + table correction in
  docs/OPENCLAW_VERSION_STABILITY.md. **#59 stays in_progress: dispatch code DONE + proven on 6.1; the
  blocker is the harness, version-independent.** Live-agent verification (and the 5.19 round-trip) needs
  the harness bring-up fixed first (or a non-reset container). Checkpoint item; tracked as a new task.
  **#54 INCREMENT 1 — CONTEXT METER + MODEL/REASONING CHIPS (read-only) BUILT + LIVE-VERIFIED 2026-06-05:**
  the chat-header "spotted strip" (CHAT_UX_DESIGN Part 3) is shipped + browser-proven. Surfaces OpenClaw
  native knobs as FEATURES: model chip, reasoning (thinking) chip with an inheritance hint, and the
  always-visible context-usage meter (color escalates green→amber→red). Pieces:
  (1) SCHEMA: `chats.sessionMeta?` (fully optional, every inner field optional → additive +
  forward-compatible; mirrors the gateway's self-describing `sessions.describe`: model/modelProvider/
  agentRuntime/thinkingLevel/thinkingDefault/thinkingLevels[]/verboseLevel/totalTokens/contextTokens/
  estimatedCostUsd). (2) QUERY: `messages.getSessionMeta(chatId)` (owner-scoped, returns {title,
  sessionMeta}). (3) FRONTEND: `ChatHeader` in `ConvexChat.tsx` + `.oc-chathead`/`.oc-chip`/`.oc-meter`
  CSS (theme tokens; inline Lucide-style SVG icons, no emoji); pct = totalTokens/contextTokens; the
  "héritée" badge shows only when thinkingLevel===thinkingDefault. (4) DEV SEED: `dev.seedSessionMeta`
  (realistic `sessions.describe` defaults: 62226/272000 ≈ 23%). (5) RECEIVING CONTRACT: ingest op
  `setSessionMeta` (`bridge_ingest.ts`) → `internal.stream.setSessionMeta` (patches chat.sessionMeta,
  non-secret labels only). **PRODUCTION CALLER LANDED (UI-2 #64, 2026-06-06):** the bridge now reports
  live meta — `server.ts performSend` reuses the `sessions.describe` it already does (for re-hydration),
  `parseSessionMeta` extracts the fields, `convex-writer.reportSessionMeta` POSTs `setSessionMeta`
  (fire-and-forget, non-fatal). Live-verified on 6.1: the header strip now shows REAL gateway values
  (gpt-5.5 · High héritée · 7% · 19.3k/272.0k) replacing the dev seed (`docs/live-evidence-ui2-sessionmeta-live.png`).
  Known v1 lag: the describe is PRE-turn → the meter reflects the previous turn (v2: re-describe post-finalize).
  **LIVE-VERIFIED (3 ways):** seed 23% → green meter + "gpt-5.5" + "Réflexion :
  High · héritée" (matches image #27 exactly: `23% · 62.2k/272.0k`); re-seed 92% + medium → RED meter +
  "Medium" with NO héritée badge (escalation + inheritance logic + Convex reactivity, no reload); and a
  raw `curl POST /bridge/ingest setSessionMeta` (gpt-5.4-mini/low/48%) → strip updated → proves the
  RECEIVING CONTRACT end-to-end WITHOUT the gateway. Evidence: docs/live-evidence-54-chathead-strip-*.png.
  tsc(src+convex)+vite build green. **REMAINING (the producer half, BLOCKED on harness #61 — NOT built
  blind):** the bridge must call `conn.request("sessions.describe", { key: sessionKey })` (param is
  `key`, verified via the earlier read-only probe) after a turn and POST the parsed meta via a new
  `convex-writer.reportSessionMeta` → the `setSessionMeta` ingest op. Clean integration point:
  `bridge/src/session.ts` finalize (it holds conn+sessionKey+chatId+writer). Deferred because the gateway
  RPC can't be live-verified while the harness send-path is broken (#61) — wiring it blind would give
  false confidence. Field mapping = the `sessions.describe` shape in CHAT_UX_DESIGN §2.1. **Write-back
  (`sessions.patch`) increment stays gated on the off-hours param probe (also needs a working gateway).**
  **UI-3 #65 — WRITE-BACK "Avancé ▾" PANEL — DONE + LIVE-VERIFIED 2026-06-06 (6.1 end-to-end, 5.19
  linchpin):** the header strip now lets the user CHANGE the OpenClaw reasoning level + model for this
  chat, applied IMMEDIATELY (not next-send — that earlier design FAILED the acceptance test + trust
  rule; corrected after advisor). Flow: `chats.setSessionKnob` (owner-scoped) persists
  `chats.sessionSettings {thinkingLevel?,model?}` + schedules `internal.bridge.dispatchPatch` →
  `POST /patch` (NEW bridge endpoint) → `applySessionSettings` (sessions.patch) → describe →
  `reportSessionMeta`. The chip reads LIVE `sessionMeta` (honest, NO optimism). `performSend`
  RE-APPLIES `sessionSettings` before its describe (survives session reset, 1-turn convergence).
  Model list mirrored from `models.list` (fetched once/connection, deduped by id) →
  `sessionMeta.availableModels`. **Verbose EXCLUDED** (verboseLevel=full is load-bearing for streaming)
  — decision SURFACED (a muted note in the menu + code comments), not silently dropped. LINCHPIN
  (`describe` reflects `sessions.patch` IMMEDIATELY) confirmed on BOTH 6.1 and 5.19; the reasoning enum
  `[off,minimal,low,medium,high,xhigh]` + `models.list {models:[{id,name,provider}]}` are IDENTICAL
  across versions. Browser-verified on 6.1 (chat jx7f3yr): Avancé → reasoning radio (6 levels + "défaut"
  marker), High→Low (gateway=low confirmed by probe, chip honest "Low"), "Hériter de l'agent (High)" →
  gateway=high + chip "High héritée", model gpt-5.5→gpt-5.4-mini (gateway confirmed, chip follows) →
  restored. Files: schema.ts, chats.ts (setSessionKnob), bridge.ts (dispatchPatch + openclaw.patch trace),
  server.ts (PatchBody, applySessionSettings, ensureAvailableModels, performPatch, /patch route,
  performSend re-apply), convex-writer/bridge_ingest/stream (availableModels), messages.getSessionMeta,
  ConvexChat.tsx (SessionKnobsMenu) + convexChat.css. Gates: tsc(src+convex) 0, vitest 103, build bridge
  + 42 tests. NEVER committed.
  **UI-4 #66 — TRANSCRIPT/STREAMING "EXCEPTIONAL" PASS — DONE + LIVE-VERIFIED 2026-06-06 (pure
  frontend, no bridge/version dependency):** elevate WITHOUT redoing the solid OWUI/increment-3 work.
  (1) STREAMING STATES — calm French chips driven by a PURE function `runStatusView(status, hasText)`
  (extracted + unit-tested because the states are transient/un-screenshottable): `thinking` (streaming,
  no text) = animated 3-dots + "Réflexion…" (the typing indicator); `generating` (streaming + text) =
  soft pulse + "Génération…"; `error` = Lucide CircleAlert + "Erreur" + message; `aborted` = Square +
  "Interrompu"; complete = no chip. (2) a11y — kept `role="status"` (live polite) on the STATUS chip
  ONLY, NOT the streaming body (advisor: a body live-region would re-announce every token). (3)
  MICRO-INTERACTION — fade+rise-in scoped to `.oc-thread__viewport > .oc-msg:last-child` ONLY (so
  opening/switching to a populated chat shows it SETTLED — only the newest turn animates; the prior 70
  render at full opacity). SAFE on finalize because the message id is the stable Convex `_id` (no remount
  streaming→complete). Deterministically verified: of 71 msgs, first/mid `animationName==="none"`, last
  `==="oc-msg-in"` (caught + fixed an advisor-flagged regression where the whole transcript faded in at once).
  (4) prefers-reduced-motion GLOBAL guard disables msg-in/dots/pulse. (5) Composer no-emoji fix: 🔧 →
  Lucide Wrench + focus-visible. Files: src/chat/runStatusView.ts (+.test.ts, 10 tests), RunStatus.tsx
  (rewrite), ConvexChat.tsx (Wrench), convexChat.css. Live-captured on 6.1 (chat jx7f3yr): "Réflexion…"
  dots animating during a web-search turn, then complete → markdown intact (no chip); "Erreur" chip
  rendered on a real failed turn ("codex app-server client closed"). generating/aborted = unit-test
  covered (codex harness produces a snapshot, not token deltas, so the no-text window is <200ms and
  cancel is not wired). Gates: tsc src 0, vitest 116 (+10). NEVER committed. DEFERRED to UI-5: retry-on-
  error (needs an onReload re-dispatch + gateway), the in-text streaming caret, final a11y/contrast/44px
  sweep, export transcript.
  **UI-5 #67 — EXPORT + a11y FINALE — DONE + LIVE-VERIFIED 2026-06-06 (final increment, pure frontend):**
  (a) EXPORT TRANSCRIPT (md + json) — an "Exporter ▾" menu (Lucide Download) in the ChatHeader reads the
  owner-scoped `listByChat` (bounded 200) imperatively on click → PURE unit-tested serializers
  `transcriptToMarkdown`/`transcriptToJson` (src/chat/transcriptExport.ts, 7 tests) → Blob + `<a download>`
  (slugified filename, accents stripped). CLEAN shape (role/text/timestamp/attachments — no `_id`/`runId`/
  `status` leaked). When the 200 window is hit, the file carries an EXPLICIT truncation marker (advisor: a
  silent drop betrays "the transcript"); file parts → `[fichier : name]`, tool/reasoning omitted.
  Live-captured deterministically (hooked `URL.createObjectURL`): 11,274 chars of real markdown (title +
  export date + `## Utilisateur`/`## OpenClaw` headers). (b) SR FINAL-ANSWER ANNOUNCE (`ThreadAnnouncer`)
  — a PERSISTENT visually-hidden `aria-live="polite"` region, EMPTY before completion (mounting it WITH
  text suppresses many SRs), populated with a SHORT cue "Réponse reçue." (NOT the full answer — a polite
  region reads it all) once per completed assistant turn; `useEffect` keyed on the completed-message id +
  a last-announced ref (silent baseline on open/switch, so history is not announced); a trailing-space
  TOGGLE forces re-announcement (a second identical cue is otherwise mute). Verified deterministically:
  region "" on load → "Réponse reçue." after a turn → "Réponse reçue. " (space) after a 2nd. (c) a11y:
  focus-visible on composer send/attach/cancel + `.oc-iconbtn` (copy); a 2.5rem (40px) hit-area — NOT a
  forced 44px (advisor: avoid clunky on a dense desktop composer); `.oc-sr-only` standard clip;
  reduced-motion guard (from UI-4). (d) FLAGGED for the human checkpoint: the Attach DRAG-DROP test (CDP
  cannot drive assistant-ui's file picker). Files: transcriptExport.ts (+.test.ts), ConvexChat.tsx
  (ExportMenu + ThreadAnnouncer + downloadText), convexChat.css. Gates: tsc src+convex 0, vite build OK,
  vitest 123 (+7). NEVER committed. STILL DEFERRED: retry-on-error (onReload + gateway), in-text streaming
  caret. **→ The UI program (UI-1..UI-5) is COMPLETE; the remaining open item is the NAS sign-off (#62).**
  **UI-6 #68 — UX FIXES (Olivier feedback) — DONE + LIVE-VERIFIED 2026-06-06:** (1) HOVER SHIFT — the
  per-message copy ActionBar was hover-revealed IN FLOW, pushing the transcript down; fixed by reserving
  space (`.oc-msg__col` padding-bottom 1.9rem) + `.oc-msg__actions { position:absolute; bottom:0 }`
  (overlay). (2) NO SUGGESTIONS on a new chat (empty state = avatar + "Comment puis-je aider ?" only;
  SUGGESTED_PROMPTS + CSS removed). (3) "Derniers messages" PILL — assistant-ui DISABLES (not unmounts)
  it at the bottom; our CSS still showed it → `.oc-scrolldown:disabled { opacity:0; visibility:hidden }`
  (already position:absolute, so no flow impact) → appears ONLY when scrolled up. (4) COMPOSER REDESIGN —
  a single unified card (ChatGPT-style): input on top (borderless), one action bar below (+ attach /
  Outils on the left, a circular Send/▲ — Stop/■ while running — on the right); the CARD owns the border
  + `:focus-within` ring (zero focus shift). Voice mic OMITTED (talk.* not wired — a dead control would
  mislead). Verified deterministically: actions position=absolute, pill hidden-at-bottom/visible-scrolled,
  composer focusShift=none, Send enables on text. Files: src/chat/ConvexChat.tsx + convexChat.css. Gates:
  tsc src 0, vite build OK, vitest 123. NEVER committed.
  **UI-6b — VOICE MIC AS A SETTINGS FLAG (Olivier's choice) — DONE + LIVE-VERIFIED:** the composer mic is
  gated by a per-user feature flag `voiceInput` (schema `profiles.voiceInput` optional, default false; new
  `me.setVoiceInput` mutation; `me.getMe` returns it). Toggle "Saisie vocale (micro)" lives in the account
  ("Compte ▾") menu next to the theme prefs (UserMenu reads voiceInput via getMe directly, no prop-drill).
  The composer shows the mic ONLY when the flag is on; while talk.* is unwired the mic is a placeholder
  (tooltip "Dictée vocale — bientôt disponible"). Verified live: flag off → no mic; toggle on → mic
  appears (right group, before Send), matching Olivier's reference. Files: convex/{schema,me}.ts,
  src/chat/{UserMenu,ConvexChat}.tsx. When the voice phase lands, wire the mic onClick + the recording.
  **UI-7 #69 — MESSAGE DELETE + REGENERATE + CASCADE + GATEWAY REALIGN — DONE + LIVE-VERIFIED 2026-06-06:**
  delete action under BOTH assistant + user turns (copy stays). Semantics (messages.deleteMessage,
  owner-scoped, truncate-forward): delete an ASSISTANT turn → remove it + all following, then REGENERATE
  the now-last user turn; delete a USER turn → remove it + all following. BOTH deletes confirm via a
  styled shadcn AlertDialog (`useConfirm()`, replaces window.confirm) with role-specific copy —
  assistant: "Supprimer et régénérer cette réponse ?"; user: "Supprimer ce message et les suivants ?".
  **CRITICAL realignment (advisor):** deleting in Convex does NOT remove the turn from the OpenClaw
  session, so EVERY delete schedules a `sessions.reset` (new bridge `POST /reset` + `dispatchReset`
  action) → `systemSent=false` → the next turn re-hydrates from the TRUNCATED Convex state → gateway
  realigned. For regenerate, `dispatchReset` chains the re-dispatch ONLY after a successful reset (so it
  runs on the fresh, re-hydrating session — never the stale one). Pieces: bridge server.ts (/reset +
  performReset + parseResetBody), convex/bridge.ts (dispatchReset), convex/messages.ts (deleteMessage +
  regenerate outbox with reconstructed attachments + unique clientMessageId), convertMessage.ts
  (messageId in metadata for the authoritative delete id), ConvexChat.tsx (DeleteMessageButton + both
  action bars) + convexChat.css. LIVE-VERIFIED 6.1 (jx7f3yr): delete assistant "417" → regenerate "437"
  (bridge log: reset → "fresh session -> prepended 71 prior turns"); delete user "Donne un nombre" →
  cascade (it + "437" removed, tail truncated to "OK"). `sessions.reset` probed: accepted, systemSent→false.
  Gates: tsc src+convex 0, vite build OK, vitest 123, bridge 55. NEVER committed. DEVIATION surfaced: a
  MID-thread assistant delete truncates everything after it (more than the literal "regenerate last user
  turn") — identical for the LAST turn (the common case); coherent for mid-thread. OUTCOME (model no
  longer sees deleted content after realignment) → NAS #62 case 9 (codex-harness masks it locally).
  **UI-8 #70 — CONTENT FIDELITY (anti-mutation composer + per-message Source view) — DONE + LIVE-VERIFIED
  2026-06-06:** Olivier reported words changing at submit (autocorrect) + doubt about AI response fidelity.
  VERIFIED our pipeline does NOT corrupt prose: `sendMessage` stores `args.text` verbatim; the user bubble
  renders PLAIN text (not markdown); on the AI side `normalizer.this.text` accumulates the raw candidate
  (snapshot replaces / delta `+=` = lossless concat of JSON-parsed strings) and `sanitize.ts:sanitizeText`
  EARLY-RETURNS VERBATIM unless the text contains a server-path marker (so normal prose is byte-identical;
  it only rewrites server paths → basename for security + drops MEDIA:/path: machine directives). So
  `message.text` = the agent's exact output (prose-faithful). Built: (a) composer hardening — `autoCorrect`
  /`autoCapitalize`/`autoComplete="off"` + `data-gramm="false"` on the input (spellCheck kept — underlines,
  never mutates); (b) per-message "Source" view (user + AI): `rawText = message.text` surfaced in
  convertMessage metadata; a `<>` toggle in the action bar swaps the rendered body for `MessageSource` — the
  EXACT stored string in a monospace `white-space:pre-wrap` block, no markdown/transform. Gated to settled
  messages (the action bar is `hideWhenRunning`). ANSWER to "can words change as tokens arrive?": YES via
  `message.snapshot`/`message.final` replacing the text (the gateway revising, faithfully mirrored) — the
  Source view shows the final stabilized text. Files: ConvexChat.tsx (Composer attrs, MessageSource,
  SourceToggleButton), convertMessage.ts (rawText), convexChat.css. Gates: tsc src 0, vitest 123, vite
  build OK. NEVER committed. DEFERRED (separate feature): provenance of the INPUTS that fed a response
  (prompt/context/tool inputs) = observability/trace, not text fidelity.
  **UI-8b SOURCE-VIEW HARDENING — DONE + LIVE-VERIFIED 2026-06-06:** answer to "can the BROWSER alter the
  raw source view?". The ONLY display-layer risk is font ligatures/contextual alternates (`->`→`→`). Fixed:
  `.oc-msg__source-pre { font-variant-ligatures: none; font-feature-settings: "liga"/"clig"/"calt"/"dlig" 0 }`
  (verified live: computed `fontVariantLigatures: "none"`). Added a "Copier la source exacte" button (the
  copy = the byte-exact bytes for external diff/hex) + a code-point counter (`[...str].length`, NOT `.length`
  — an emoji must not inflate it). Files: ConvexChat.tsx (MessageSource head), convexChat.css.
  **UI-9 #71 — REPORT FEEDBACK + ON-DEMAND FORENSIC SNAPSHOT — INCREMENT A DONE + LIVE-VERIFIED 2026-06-06:**
  OpenRouter-style flag in the action bar (user + AI) → shadcn Dialog (category Select + comment 0/1000 →
  Submit) → `feedback.submitFeedback` FREEZES a complete forensic snapshot. WHY a snapshot (not a reference):
  UI-7 delete/regenerate would erase the disputed evidence; the snapshot preserves it at report time. WHY
  on-demand (not per-message): the feedback IS the dispute signal — capture everything only when it matters.
  TRUST MODEL (non-negotiable): `snapshot.messageText` + all authoritative fields are SERVER-READ from the
  DB in the mutation, NEVER from the client; `displayedText` is the ONLY client-declared content (the
  byte-exact `.oc-msg__source-pre` textContent / `rawText`) and exists solely so the server computes
  `displayedMatchesStored` — the DATA-BACKED answer to "did the browser change the characters?". Captured
  ("n'oublie rien"): message text/role/status/runId, isRegeneration (regen-* outbox key), parts (bounded),
  prompt + bounded context window (limit RECORDED, contextTruncated flag — no silent truncation), sessionMeta
  + sessionSettings + model/provider/runtime, dispatched outbox payload (best-effort via new outbox
  `by_message` index — FOUND in the live row), clientInfo (UA/locale/tz/theme), realUserId + impersonated.
  AUDIT: every submit → `recordAudit("feedback.submit")` with realUserId (a report filed while impersonating
  is attributable). PRIVACY REFRAME (Olivier): admin has no privacy constraint (can already impersonate) —
  storing content is OK; the rule is admin cross-user content ACCESS must be AUDITED (verified: the only
  admin path to another user's content is impersonation, already audited at start/stop; listByChat + search
  are owner-scoped to the effective id, no bypass). VERSION-INDEPENDENT by construction: the feedback path
  has ZERO OpenClaw coupling (reads stored Convex rows) — the 5.19/6.1 matrix is moot here (live row captured
  against the running instance). Files: schema.ts (feedback table + outbox by_message index), feedback.ts
  (submitFeedback + myReportedMessageIds), feedback.test.ts (4: server-read truth survives a FORGED
  displayedText, owner-scope, invalid category, impersonation audit), messages.ts/convexTypes.ts/
  convertMessage.ts (chatId on the message view), FeedbackDialog.tsx, ConvexChat.tsx (FeedbackButton wired),
  convexChat.css. Gates: tsc src 0, tsc convex 0, vitest 127 (feedback 4), vite build OK. Live: dialog opens,
  full submit → row stored with the full snapshot above. NEVER committed. VERDICT HONESTY (advisor-caught,
  fixed): the STRONG "le texte affiché correspond" claim is shown ONLY when the source view was open
  (`sourceWasOpen` → displayedText = the hardened `.oc-msg__source-pre` textContent = a real DOM read);
  with source CLOSED, displayedText falls back to `rawText` (client copy of message.text) so a match proves
  transport consistency, NOT display fidelity → the dialog shows an actionable "open the source view and
  re-flag" message instead of overclaiming. INCREMENT B (consciously deferred): (1) admin forensic READ view
  of feedback + snapshot — gated by `traces.read.content` + audited on each cross-user content read ("admin
  sees other users' info" → must be traced, per Olivier's rule); (2) `contentHash`/tamper-evidence — the
  snapshot is a DB row an admin could edit; an append-only or hashed guarantee raises it to "cannot be
  disputed" (the field exists in schema, unset for now — no deterministic sync hash in a mutation).
  **UI-9 FIX (Olivier) — DONE + LIVE-VERIFIED 2026-06-06:** (1) the flag on USER messages opened the dialog
  then it CLOSED on mouse-leave — root cause: the dialog was rendered INSIDE the action bar, and assistant-ui
  `autohide` UNMOUNTS the bar's children on mouse-leave (the AI/last message stays shown so it worked there).
  Fixed by lifting the dialog to an app-root `<FeedbackProvider>` + `useFeedback()` (mirrors useConfirm,
  wired in main.tsx inside DialogsProvider); `FeedbackButton` now only CAPTURES the target + rendered text at
  click and hands it to the root dialog → lifecycle independent of hover. Verified: user-message dialog opens
  AND survives mouse-leave. (2) ROLE-BASED categories: AI report = 7 (Réponse incorrecte/Incohérence/Mots-
  orthographe erronés/Formatage/Latence/Erreur API/Autre); USER report = 3 (Mots modifiés à l'envoi/
  Caractères-mise en forme altérés/Autre) — all ids stay within the server FEEDBACK_CATEGORIES set (no
  backend change). Live: AI shows 7, user shows 3, user submit stored with messageRole "user". Files:
  FeedbackDialog.tsx (provider refactor + role categories), main.tsx (FeedbackProvider wiring). Gates: tsc
  src 0, vite build OK.
  **#53 INCREMENT 3 — COMPOSER POLISH BUILT + LIVE-VERIFIED 2026-06-05 (pure frontend, no live agent):**
  via assistant-ui 0.14 primitives in `ConvexChat.tsx` + `convexChat.css`: (1) EMPTY STATE
  (`ThreadPrimitive.Empty`) — OC avatar + "Comment puis-je aider ?" + 4 suggestion cards
  (`ThreadPrimitive.Suggestion send={false}` → fills the composer for review, NOT auto-send; prompts
  showcase proven capabilities: web search, downloadable file exchange, mail). (2) SCROLL-TO-BOTTOM
  pill (`ThreadPrimitive.ScrollToBottom`, auto-hides at bottom, wrapped in `If empty={false}` so it
  never shows on an empty thread). (3) PER-MESSAGE COPY on assistant turns (`ActionBarPrimitive.Copy`,
  `hideWhenRunning` + `autohide="not-last"`; flips to a check on `MessagePrimitive.If copied`).
  **Régénérer (Reload) deliberately NOT rendered:** the external-store runtime
  (`useConvexChatRuntime`) implements only `onNew` (no `onReload`), so `ActionBar.Reload` would be a
  DEAD button — dropped until an `onReload` re-dispatch of the last user turn is built (+ a working
  gateway to verify). Inline Lucide-style SVG icons (no emoji). "Stop generating"
  (`ComposerPrimitive.Cancel`) already existed. LIVE-VERIFIED: 2×2 suggestion grid renders
  (docs/live-evidence-53-emptystate-suggestions.png); clicking a suggestion fills the composer +
  enables Send; copy/reload + scroll pill render on a populated chat and the pill is correctly hidden
  on the empty chat. tsc(src)+vitest(97 pass)+vite build green. Lower-priority Part-4 remainder: export
  transcript (md/json), voice/Talk, the full a11y/motion pass.
- **CHAT UX + CONFIG-OPTIONS work QUEUED (tasks #53/#54, see docs/CHAT_UX_DESIGN.md):** research done
  (eye-tracking/F-pattern/layer-cake, conversational design, streaming, composer, a11y) + the OpenClaw
  feature inventory + the REVISED schema decision (knobs come from `sessions.describe`
  self-describing enums — `thinkingLevels`/`verboseLevel`/`model`+`models.list` — NOT a generic
  `config.schema` renderer; context meter = `totalTokens/contextTokens`, validated 22.9%≈23%).
  Increment 1 (read-only context meter + model/reasoning chips) is next; RAPIDE/RAISONNEMENT +
  `sessions.patch` write-params need a follow-up probe.
- STILL OPEN (Tier 1/2 per the matrix): run-state channel for processing markers (#5), media
  in/out, archived recovery / chat.history (#3), multi-user per-instance routing (#4), wire the
  multiplexer (#6), the per-session-vs-per-agent isolation probe (#7), UI markers + tool-toggle
  (needs chrome-devtools). New harness oracle helper still TODO (clean message-state read).

NEW DEV/LIVE TOOLING (all dev-gated, `OPENCLAW_ENABLE_ANON_AUTH=1`): `dev.routeUser`
(wire profile override → instance, makes dispatch resolve a non-null target — ran: olivier
→ instance "admin"); `dev.testSend({text,chatId?})` (programmatic send = mirrors
send.sendMessage → outbox → dispatch, the live-harness trigger, no browser needed);
`openclaw-client.ts` debug instrumentation gated by **`BRIDGE_DEBUG=1`** (logs hello-ok +
server.version, each req method+sessionKey [no PHI text], each res/ack, each raw inbound
frame = fixture/diagnosis material). Build-config fixed: `bridge/tsconfig.build.json`
(rootDir src) → `dist/index.js`; `npm start` = `node --env-file=.env dist/index.js`.
**Run the bridge:** `cd bridge && npm run build && BRIDGE_DEBUG=1 node --env-file=.env dist/index.js`
(listens :8787; gateway connect is LAZY = on first send). `.env` gotcha: `OPENCLAW_DEVICE_IDENTITY`
must be UNQUOTED raw JSON (Node --env-file truncates a quoted value at the first inner `"`);
fixed via `/tmp/fix-devid.mjs` (backup at `bridge/.env.bak`).

**Phase 2 IN PROGRESS (Model A).** DONE so far: `providers/openclaw/multiplex.ts`
`SessionMultiplexer` — the risk core: one Normalizer per session, fan-out by
`payload.sessionKey`, min-deadline tick, per-sessionKey verbose guard (fix #7), endAll.
**The sessionKey routing IS the per-user isolation boundary** (Gateway gates by scope,
not user). 5 offline tests (`test/multiplex.test.ts`): interleaved-no-cross-talk,
unknown-session drop, min-deadline selectivity, verbose-per-sessionKey, endAll. Gate:
bridge tsc 0, 36 bridge tests green. STILL TODO in P2: wrap the multiplexer in
`providers/openclaw/adapter.ts` (`BridgeProvider`: connect ONE WS, sendMessage→sessionKey
+verbose guard+chat.send+ack runId+beginSession, the single-pending-read consume loop
racing one frame-read vs `mux.minTimeout`, emit via `on(chatId,event)`, abort=local
finalize) + `core/registry.ts` (instance-keyed, lazy connect/reuse/reconnect) + the
core on()→TurnSink-per-chat wiring; the consume loop + sendMessage need a FakeConnection
for offline tests, then the live T1–T4. Also: capture the real sessionKey grammar live (T4). `BRIDGE_PROTOCOL.md`
normalized-events section = STILL the contract; its Firebase/browser-WS/signed-media
sections are STALE (superseded by the Convex design).

### 5.3 Documented deferrals (do when relevant)
- **M8** end-to-end correlationId (outbox↔runId) — needs the bridge.
- **D-1** assign CUSTOM roles to USERS (widen `profiles.role` from union → string;
  use convex-migration-helper widen-migrate-narrow; preserve all literal "admin"/
  "pending" comparisons + last-admin guard + impersonation). RBAC matrix already
  supports custom roles for SERVICE ACCOUNTS only today.
- **ConvexError for prod**: user-facing thrown `Error`s (last-admin refusal,
  duplicate key, validation) are masked to "Server Error" in PROD by Convex; convert
  to `ConvexError` so the toast shows the real message in prod (dev already shows it).
- **D-4** `traces.read.content` permission is defined-but-inert (content capture).
- Anomalies "egress_wedged" agent anomalies don't auto-clear on vendor recovery.
- Named theme palettes beyond neutral (themeName/defaultThemeName reserved).

---

## 6. Env vars (deployment)
- Auth: `JWT_PRIVATE_KEY` (PKCS8 real newlines), `JWKS` (raw JSON), `SITE_URL`
  (http://127.0.0.1:3213), `OPENCLAW_ENABLE_ANON_AUTH=1` (dev anon + dev.* funcs).
- Bridge: `BRIDGE_INGEST_SECRET`, `OPENCLAW_MEDIA_BASE_URL`, `BRIDGE_URL`,
  `BRIDGE_SHARED_SECRET` (the last two for openclaw.query; bridge worker still TODO).
- Retention: `TRACE_RETENTION_DAYS` (default 14).
- Vendors (optional): `LANGFUSE_PUBLIC_KEY`/`LANGFUSE_SECRET_KEY`/`LANGFUSE_HOST`;
  `OPIK_API_KEY`/`OPIK_WORKSPACE`/`OPIK_BASE_URL`. Unset ⇒ flush no-ops.
- `.env.local`: `VITE_CONVEX_URL=http://127.0.0.1:3212`, `VITE_CONVEX_SITE_URL=http://127.0.0.1:3213`.

## 7. Dev test data left in the local DB (harmless; clean when convenient)
Service accounts: `obs-cli, agent-cli, smoke6, obs-test, anom-test, kpi*-consol,
kpi-test*, usr-*/obs-* verify/consol`, etc. A test user (`kh789…`) + chat + outbox
(increment-3 live check). Demo chats "Aperçu du rendu". Two real admins exist:
`u-kh77jp16fe` (browser session, themeMode dark) and `u-kh74bs68n5`. `dev.reset`
now wipes ALL tables but ALSO profiles/chats → next sign-in re-bootstraps admin
(don't run it casually). No `deleteServiceAccount` was run to clean the test
accounts; they're visible in the Service accounts tab.

## 8. How to resume after /compact
1. Read THIS file + the memory index (auto-loaded). 2. Confirm gates green (§1).
3. If chrome-devtools MCP is back → do §5.1 browser pass. 4. Continue stable-bricks
work or start §5.2 (bridge worker). 5. Respect §3 invariants and compose §4 bricks.
User preferences: respond in FRENCH; code comments in English; NEVER `git commit`/
`push` (user owns commits); delegate big work via single-writer agents/workflows with
strict gates; verify independently (don't trust self-reports); use the advisor before
big approaches + before declaring done.
