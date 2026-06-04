# PROJECT STATE — openclaw-webchat (resume anchor)

**Purpose of this file:** the single, durable, detailed snapshot to RESUME from
after a context compaction. Read this first. It is kept current as work lands.
Last verified-green: **2026-06-03** — `tsc src` 0, `tsc convex` 0, `vitest` 87
(convex+routing) + mcp 36, `vite build` OK.

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
