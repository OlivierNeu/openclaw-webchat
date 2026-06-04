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

### 5.2 THE major milestone — Bridge worker → OpenClaw gateway (NOT built)
A Node/TS worker (`bridge/`, drafts + proven `bridge/src/normalizer.ts` = 23 tests)
that: holds the OpenClaw operator WS; runs the normalizer (streaming transducer);
consumes the Convex `outbox` (sends land as `failed` today — no live gateway);
POSTs normalized events to `POST /bridge/ingest` (Bearer `BRIDGE_INGEST_SECRET`,
constant-time compare → `internal.stream.*`); implements **`POST /query`** (for
`/api/v1/openclaw/query`, env `BRIDGE_URL` + `BRIDGE_SHARED_SECRET`); and writes the
OpenClaw **runId back onto the outbox row** to close M8 (end-to-end correlationId).
`BRIDGE_PROTOCOL.md` = the normalized-events contract. This unblocks real chatting.

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
