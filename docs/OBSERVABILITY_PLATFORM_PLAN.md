# Observability & Analysis Platform — Implementation Plan / Contract

Status: **in progress** (incremental). This doc is the *contract*: module agents fill
bodies against the pinned interfaces below; shared files have a single writer.

## Goal

A real debugging / analysis center for what happens between the webchat and
OpenClaw — consumable by the **admin** (UI) and by **OpenClaw agents** (key-authed
API + MCP/CLI). Traces, KPIs, anomaly detection + self-repair signals, Opik/Langfuse
integration, and an RBAC permission matrix (users + service accounts) that is **never
exposed over the API**.

## Locked decisions (do not improvise)

- **D1 — Storage split.** Convex is a reactive transactional DB, *not* a log store.
  - Convex holds: a **bounded recent trace window** (`traceEvents`, retention cron)
    + **KPI rollups** (small, aggregated, long-lived).
  - The **firehose** (full spans) is shipped to **Opik and/or Langfuse**, which exist
    for exactly this. Convex links to them by `correlationId`.
  - Retention horizon: `TRACE_RETENTION_DAYS` (deployment env, default **14**). A daily
    cron deletes `traceEvents` older than the horizon (bounded batches).
- **D2 — PHI.** Default traces store **metadata + redacted content** (lengths, hashes,
  roles, status, latency — never raw message text). Full-content capture is gated
  behind the `traces.read.content` permission *and* an explicit capture flag. Documented
  as revisitable. Never log gateway tokens / device identities / API key plaintext.
- **D3 — Secrets.** API keys are stored **hashed only** (SHA-256, Web Crypto). Plaintext
  is shown **once** at creation and never persisted. Bridge/gateway secrets stay in
  deployment env (unchanged).
- **D4 — RBAC management is admin-only Convex functions, NO HTTP route.** The API
  surface (`/api/v1/*`) can *check* permissions but can never *manage* roles/keys.
- **D5 — Don't rewrite `lib/access.ts`.** Add an `lib/rbac.ts` layer. Preserve
  impersonation (`getActor` effective-vs-real), first-admin bootstrap OCC, last-admin
  guard, and audit attribution. Built-in role keys `pending|user|admin` map onto the
  new role→permission model.

## Permission keys (compile-time constants, `lib/rbac.ts`)

```
traces.read            traces.read.content     traces.write
kpi.read               kpi.write
openclaw.query                                  (query OpenClaw via the bridge)
anomalies.read         anomalies.report
chats.read                                      (read conversational data)
admin.manage                                    (superset; UI/admin only)
```

## Built-in roles (seeded into `roles`)

| key       | permissions                                                                 | for            |
|-----------|------------------------------------------------------------------------------|----------------|
| pending   | —                                                                            | user (blocked) |
| user      | chats.read                                                                   | user           |
| admin     | * (all)                                                                      | user           |
| observer  | traces.read, kpi.read, anomalies.read                                        | service account|
| agent     | traces.read, kpi.read, openclaw.query, anomalies.read, anomalies.report      | service account|

Custom roles can be added with any subset of permission keys (the matrix UI).

## Schema additions (single writer = foundation; all new tables required-field OK)

- `roles`: `{ key: string, name: string, description?: string, builtin: boolean, permissions: string[] }` — index `by_key`.
- `serviceAccounts`: `{ name: string, roleKey: string, disabled: boolean, description?: string, createdByUserId: Id<"users"> }` — index `by_name`.
- `apiKeys`: `{ serviceAccountId: Id<"serviceAccounts">, hashedKey: string, prefix: string, lastFour: string, disabled: boolean, createdAt: number, lastUsedAt?: number, expiresAt?: number }` — indexes `by_hash` (["hashedKey"]), `by_account` (["serviceAccountId"]).
- `traceEvents`: `{ at: number, kind: string, direction?: "inbound"|"outbound"|"internal", principalType: "user"|"service"|"system", principalId?: string, roleKey?: string, route?: string, method?: string, status?: number, latencyMs?: number, chatId?: string, runId?: string, correlationId?: string, redacted: boolean, meta?: string }` — indexes `by_at` (["at"]), `by_correlation` (["correlationId"]), `by_principal` (["principalType","principalId"]).
- `kpiRollups`: `{ bucket: string (e.g. "2026-06-02T14"), metric: string, value: number, dims?: string }` — index `by_bucket_metric` (["bucket","metric"]).
- (Increment 1 may stub `kpiRollups`/anomaly tables; bodies later.)

## Function / module contracts

- `lib/rbac.ts` (pure, no ctx where possible):
  - `export const PERMISSIONS` (const object), `export type Permission`.
  - `export const BUILTIN_ROLES: Record<string, {name,permissions:Permission[]|"*"}>`.
  - `permissionsForRoleKey(ctx, roleKey): Promise<Set<string>>` (reads `roles`, falls back to BUILTIN).
  - `roleHasPermission(perms: Set<string>, p: Permission): boolean` (`*` ⇒ all).
  - `seedBuiltinRoles(ctx)` — idempotent (OCC-safe upsert by key).
- `lib/apikeys.ts`:
  - `generateApiKey(): { plaintext, prefix, lastFour }` (action-only; `oc_live_<base62>`).
  - `hashKey(plaintext): Promise<string>` (SHA-256 hex via `crypto.subtle`).
  - **Mint in an ACTION** (random + hash are non-deterministic ⇒ illegal in query/mutation).
  - **Verify in the httpAction**: hash presented key, `ctx.runQuery(internal.apikeys.findByHash,{hash})`.
- `apiKeys.ts` (Convex functions):
  - internalQuery `findByHash({hash})` → key doc | null.
  - admin mutations/actions: `createServiceAccount`, `mintApiKey` (action; returns plaintext ONCE), `revokeApiKey`, `listServiceAccounts`, `listKeys`. All `requireAdmin`.
- `observability.ts`:
  - internalMutation `recordEvent(event)` (the single trace writer; applies D2 redaction).
  - query `listEvents({filters})` — admin OR principal with `traces.read` (content only with `traces.read.content`).
- `lib/apiAuth.ts` (for httpActions): `authenticateApiKey(ctx, request): Promise<{ok, principal, key} | {ok:false, status}>` — parses Bearer, hashes, finds, checks disabled/expiry, resolves role, bumps `lastUsedAt`. `requirePermission(ctx, principal, perm)`.
- `http.ts` (single writer): add
  - `GET /api/v1/health` (no auth, no PHI).
  - `GET /api/v1/traces` (key-auth → `traces.read` → records an `api.call` trace → returns recent events). **This is the increment-1 proof route.**
- `crons.ts` (new): daily `observability.purgeOldTraces` (bounded batches, > horizon).
- Admin functions are Convex-only; **no HTTP** for roles/keys management (D4).

## Verification gate (increment 1 — must pass before fan-out)

1. `vitest` + `convex-test` configured; **one real passing test** (mint key → hash → `findByHash` resolves → `roleHasPermission` true/false).
2. Live: `npx convex dev` running; `curl` the local `.site` origin:
   - `GET /api/v1/health` → 200.
   - mint a key (admin), `curl -H "Authorization: Bearer <key>" /api/v1/traces` → 200 + JSON, **and a `traceEvents` row appears**.
   - a key whose role lacks `traces.read` → **403**.
   - bad/again-revoked key → **401**.
3. `tsc --noEmit` + `vite build` green. No regression in impersonation/audit.

## Increment roadmap (each delivered + verified before the next)

1. **Spine** (this doc's contract): RBAC engine + service accounts/API keys + trace write + 1 key-authed route + retention cron + test harness. *(hand-built / single foundation agent, reviewed)*
2. **RBAC matrix UI** + extend role assignment to users; **Service accounts & API keys UI**.
3. **Trace ingest breadth**: instrument bridge in/out, ws connect/disconnect, send/stream, API calls; **Traces viewer UI** (timeline, correlationId follow).
4. **KPI rollups** (cron aggregations) + **KPI dashboard UI**.
5. **Integrations**: Opik adapter + Langfuse adapter (ship spans; pull on demand) — actions.
6. **OpenClaw query** (via bridge) + **heartbeat/anomaly** endpoint + self-repair signals.
7. **MCP server + CLI** (thin clients over `/api/v1`, key-auth) for OpenClaw.
8. Hardening: adversarial review, dead-code sweep, coverage push.

## Orchestration

- **Research** (parallel, read-only, background): Langfuse ingestion/OTel (langfuse-docs MCP),
  Opik tracing/examples (opik MCP), MCP TS SDK server (WebSearch), RBAC matrix UX (WebSearch),
  API-key best practices (WebSearch). Findings refine increments 5–7; the spine needs none.
- **Foundation** (increment 1): single writer, then independent review + live verification.
- **Fan-out** (increments 2+): Workflow with shared-file single-writer rule, isolated module
  files against pinned contracts, parallel test-gen, adversarial review + challenger + a
  completeness critic, then a fix pass. Tripwire: never let two agents touch
  `schema.ts`/`lib/access.ts`/`http.ts`/`AdminSettings.tsx`.
