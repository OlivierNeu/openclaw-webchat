# Observability Platform — Adversarial Review Punch-List

Synthesized from 6 adversarial reviews (security, backend, integrations, frontend, MCP, completeness). Duplicate findings across areas have been merged into single items. Each item carries the file(s), the concrete issue, and the fix that drives the fix pass.

**Counts:** 0 Critical · 1 High · 8 Medium · 9 Low · 5 Deferred-acceptable (23 distinct items)

**Verdict from reviewers:** The locked decisions D1–D5 hold (bounded retention + daily purge; forced `redacted:true` in the single trace writer; hashed-only API keys shown once; no `/api/v1` route manages roles/keys; `lib/access.ts` preserved alongside `lib/rbac.ts`). No auth bypass, secret leak, or PHI leak was found. The must-fix items below are admin-gated robustness gaps, client/server contract mismatches against the now-live `http.ts` routes, and a few correctness/UX bugs.

---

## Critical

None.

---

## High

### H1 — MCP `query_openclaw` tool is dead-on-arrival (client/server contract mismatch)
- **Files:** `mcp/src/tools.ts:99-110` (and `:33`), `mcp/src/server.ts:117-133`, `mcp/src/cli.ts:111-116`; server side `convex/http.ts:476-484`
- **Issue:** The client POSTs `{ prompt, chatId, runId, params }` to `POST /api/v1/openclaw/query`, but the live handler reads only `question` and `payload` and returns 400 when both are undefined. Since the client never sends `question`/`payload`, **every call 400s** — the tool can never succeed. `QueryOpenClawArgs.params` and its zod field are also dead (read by nobody server-side).
- **Fix:** Rename `prompt` → `question`; add a `payload` field. Update the zod `inputSchema` in `server.ts` (`question: z.string().optional()`, `payload: z.unknown().optional()`) and the CLI flag mapping in `cli.ts`. Remove `params` (or fold it into `payload`). Drop `chatId`/`runId` unless the route is extended to read them.

---

## Medium

### M1 — `approveUser` bypasses the last-admin lockout guard (headline must-fix)
- **File:** `convex/admin.ts:74-82`
- **Issue:** `approveUser()` only calls `requireAdmin()` then unconditionally `patch(profileId, { role: "user" })` on ANY profile — including the sole remaining admin. Its sibling `setRole` (`admin.ts:51-71`) refuses to demote the last admin and clears `impersonatingUserId` on demotion; `approveUser` does neither. An admin calling `approveUser({ profileId: <sole admin> })` causes irreversible full admin-surface lockout (recovery needs the dev-flag-gated `dev.makeAdmin`, unavailable in prod) and leaves a stale `impersonatingUserId` on the now-non-admin row. Defeats the D5 last-admin invariant via an inconsistent sibling path.
- **Fix:** Mirror `setRole`'s guard: reject when the target is currently the last admin (`roleOf(target)==="admin" && (await adminCount(ctx))<=1`), and clear `impersonatingUserId` in the same patch when moving an admin to a non-admin role. Cleanest: route `approveUser` through `setRole`'s logic so there is one guarded code path.

### M2 — Anomaly resolve path is unreachable → open set unbounded → de-dupe + heartbeat break past 500 rows
- **File:** `convex/anomalies.ts:434-456` (`resolveAnomalyInternal`); chain at `:117-155` (`upsertDetectorAnomaly`), `:464-491` (`heartbeatInternal`)
- **Issue (merged: SECURITY-low + BACKEND-medium + COMPLETENESS-medium):** `resolveAnomalyInternal` is the ONLY writer that transitions an anomaly out of `status:"open"`, and it has **no production caller** — no HTTP route (`http.ts` has GET/POST `/api/v1/anomalies` but no resolve/acknowledge), no MCP/CLI tool, no admin mutation, no UI (only its own unit test calls it). Consequences:
  1. Detector anomalies can never be cleared; a transient condition (e.g. `api.error_ratio`) opens a row that stays open forever, so `heartbeatInternal.openCount/criticalCount` never returns to 0 → the OpenClaw self-repair signal becomes permanently "tripped".
  2. The OPEN set grows without bound. Once open rows exceed `OPEN_SCAN=500`, `upsertDetectorAnomaly`'s de-dupe scan (`.take(OPEN_SCAN)` at `:130`) can miss the existing open row of a kind and insert a **duplicate**, breaking the load-bearing "one OPEN row per kind" invariant.
  3. `heartbeatInternal` (`.take(OPEN_SCAN)` at `:477`) silently undercounts `openCount/criticalCount/bySeverity` past 500 open rows, so a heartbeat can report fewer/no critical anomalies than reality.
- **Fix:** Wire `resolveAnomalyInternal` to a real surface — an admin Convex mutation (`resolveAnomaly`, `requireAdmin` + audit) and/or a key-authed `POST/PATCH /api/v1/anomalies/resolve` gated on `anomalies.report` (record an `api.call` trace like the other routes) plus an MCP tool. Separately bound open-set growth: have the detector cron auto-resolve stale open rows whose condition is no longer present, and/or de-dupe/cap agent-reported open anomalies. The heartbeat/de-dupe correctness past 500 rows must be addressed regardless of whether a resolve surface ships this increment.

### M3 — Batch-boundary data loss when many trace events share one `at` millisecond
- **File:** `convex/integrations/ship.ts:73-78`, `:232`
- **Issue:** `unsentSince()` uses a strict `gt` on the `by_at` index (`fields=['at']`, no tiebreaker) with `take(FLUSH_BATCH=200)`, advancing the cursor to `events[last].at`. If a burst produces >200 events at the same millisecond, the batch truncates mid-ms; the next flush queries `gt: events[199].at`, strictly excluding ALL remaining events sharing that exact ms — they are silently dropped and eventually purged by retention. Recurs at every batch boundary that splits a millisecond, violating the "idempotent + complete" egress intent of D1.
- **Fix:** Make the cursor a composite watermark `(at, _id)` and page with `(at > lastAt) OR (at == lastAt AND _id > lastId)`, advancing both fields (add `_id`/`_creationTime` as a secondary index tiebreaker). Minimal mitigation: when the batch is full and the last N events share `events[last].at`, advance the watermark to just below that `at` so same-ms events are re-read next flush (vendors dedupe by deterministic trace/span id, so at-least-once is safe).

### M4 — Lost-update race on the permission matrix (read-modify-write)
- **File:** `src/chat/admin/RolesTab.tsx:173-197` (`togglePermission`), `:171` (`buildMatrixRoles`)
- **Issue:** `togglePermission` computes `next` from the live `listRoles` snapshot and `updateRolePermissions` sends the FULL array (backend does a full `patch` replace, no merge). There is no optimistic update, so two quick toggles on the same role row clobber each other: click-1 writes `[A]`; click-2 reads stale `[]` and writes `[B]`; `A` is silently lost. No in-flight visual feedback makes rapid toggling natural.
- **Fix:** Attach `mutation.withOptimisticUpdate` patching the `listRoles` query result, and/or disable the checkbox while a write for that role is in flight (track a pending `roleId`).

### M5 — Mutations swallow server-side errors silently
- **File:** `src/chat/AdminSettings.tsx:122-127` (`setRole`), `:144-148`/`:172-178` (`setRouting`); same pattern in `RolesTab`/`ServiceAccountsTab` mutation calls
- **Issue:** Every mutation/action is invoked as `void mutation(...)` (or awaited without try/catch), so server rejections are swallowed. Concrete case: demoting the last admin throws `'Refused: cannot demote the last admin'`, but the controlled `<Select>` just snaps back on the next reactive tick with no explanation — looks like a broken control. Same hides duplicate-key failures from `createServiceAccount`/`createRole` and route/group updates.
- **Fix:** Wrap mutation calls in try/catch (or `.catch`) and surface a toast/inline error (reuse the project's dialog/confirm primitives; add a toast). At minimum surface the last-admin and duplicate-key errors.

### M6 — MCP `report_anomaly` contract mismatch (three ways)
- **Files:** `mcp/src/tools.ts:42-49`, `:126-138` (and dead `details` at `:47-48`), `mcp/src/server.ts:151-170`, `mcp/src/cli.ts:117-128`; server side `convex/http.ts:297-344`
- **Issue (merged: MCP-medium + `details` dead-code low):** (1) Client sends `details` but the server reads `evidence` — `details` is silently dropped and never reaches the record. (2) The server REQUIRES `kind`+`severity`+`message` and 400s otherwise, yet the zod schema and CLI mark `severity`/`message` optional (fails late). (3) The zod description in `server.ts:161` advertises severity `'info'|'warn'|'error'`, but the server only accepts `info|warn|critical` (`http.ts:300`) — a caller following the description with `severity=error` gets a 400.
- **Fix:** In `tools.ts` rename `details` → `evidence`. In `server.ts` make `severity = z.enum(['info','warn','critical'])` (required) and `message = z.string()` (required), and fix the description string. In `cli.ts` validate `severity`/`message` presence client-side (mirror the existing `--kind` guard).

### M7 — MCP `listTraces` `correlationId` filter is a silent no-op
- **Files:** `mcp/src/tools.ts:72-83`, `mcp/src/server.ts:94-96`, `mcp/src/cli.ts:98`; server side `convex/http.ts:91-99`
- **Issue:** Client sends `?correlationId=...`, advertised by server/CLI as a filter, but the GET `/api/v1/traces` handler reads only `limit` and `kind` — `correlationId` is never read. Users filtering by `correlationId` get unfiltered results with no error, on the increment-1 LIVE-proof route.
- **Fix:** Add `correlationId` handling to the handler (read `url.searchParams.get('correlationId')`, pass to `recentEventsInternal` via the `by_correlation` index) — this lands in the http/observability area. Until the server supports it, drop the `correlationId` option from tools/server/cli so it does not advertise a non-functional filter.

### M8 — No end-to-end `correlationId` linking the user-send half to the assistant-stream half
- **Files:** `convex/send.ts:186` vs `convex/stream.ts:30-38`, `:63` vs `convex/bridge.ts:51-53`
- **Issue:** `send.ts` `traceSend` and `bridge.ts` dispatch use `${chatId}:${outboxId}`, but `stream.ts` (`startAssistant`/`finalize`) and `bridge_ingest.ts` `startAssistant` use `${chatId}:${runId}`. `outboxId` and `runId` are never associated (the `runId` is assigned later by OpenClaw/the bridge and never written back to the outbox row), so the `by_correlation` index cannot follow a full turn end-to-end. The traces-viewer "correlationId follow" goal (increment 3) is broken across the send/stream boundary. (Distinct from M7: this is a backend correlation-scheme gap, not the MCP param-handling gap.)
- **Fix:** Carry a single correlationId across the turn — either (a) generate it at send time, store it on the outbox row, and have the bridge echo it back through `startAssistant` so stream traces reuse it; or (b) when the bridge learns the `runId`, write it onto the outbox row and emit a bridging trace linking `${chatId}:${outboxId}` to `${chatId}:${runId}`. Document the chosen scheme in the contract.

---

## Low

### L1 — `updateRolePermissions` lacks a server-side admin-wildcard guard
- **File:** `convex/apiKeys.ts:320-337`
- **Issue:** The backend has no equivalent of the client-side matrix lockout guard. An admin can strip the builtin `admin` role's `['*']` to `[]` directly via the mutation. Not a human-admin lockout (`requireAdmin` keys off `profiles.role`, and `seedBuiltinRoles` self-heals the row on the next create), so impact is limited to any service account carrying `roleKey 'admin'`. Defense-in-depth gap.
- **Fix:** Reject downgrading the builtin `admin` role (or any wildcard role) out of `['*']` in `updateRolePermissions`, making the lockout authoritative on the backend.

### L2 — `createServiceAccount` accepts human roleKeys (`admin`/`user`/`pending`)
- **File:** `convex/apiKeys.ts:91-122`
- **Issue:** Assigning `roleKey 'admin'` to a service account grants the wildcard permission set to an API-key principal, contradicting the role-purpose table (observer/agent are service-account roles; admin.manage is UI/admin only). Admin-gated and grants no PHI today (traces are always `redacted:true` with no raw-content column), so a role-hygiene/defense-in-depth gap, not an exploitable bypass.
- **Fix:** Restrict service-account `roleKey`s to an allowlist (non-builtin roles plus observer/agent), or at minimum reject `pending|user|admin`. Revisit if `traces.read.content` later gates real content capture.

### L3 — `?limit` query param accepts negative/non-integer values → 500 on the 3 GET routes
- **File:** `convex/http.ts:93-97` (traces), `:157-159` (kpi), `:233-237` (anomalies)
- **Issue (merged: SECURITY-low + BACKEND-low):** `limit` is parsed with `Number()` and only filtered by `Number.isFinite()`, which accepts negative (`-5`) and non-integer (`2.5`) values. A negative limit reaches `ctx.db.query(...).take(limit)`, which Convex rejects; with no try/catch around `ctx.runQuery`, the route returns a 500 instead of the contract-mandated 400. (The 500 path is not traced, so it does not feed the error-ratio detector — a "handle 400" contract gap, not security.)
- **Fix:** Clamp to a non-negative integer before `.take()`, e.g. `const limit = Math.min(Math.max(0, Math.floor(opts.limit ?? DEFAULT)), MAX)` in each fetch helper (`fetchRecentEvents`, `fetchKpis`, `fetchAnomalies`), or parse-guard in `http.ts` and return 400 on non-finite/negative input.

### L4 — Stuck-vendor infinite retry with no backoff or surfacing
- **File:** `convex/integrations/ship.ts:217-228`
- **Issue:** A persistent non-2xx (bad/expired credential 401, malformed-payload 4xx) makes `send()` return `{ok:false}`, the cursor never advances, and the IDENTICAL batch re-sends every 5 minutes indefinitely. No failure counter, no backoff, no signal beyond per-run `console.error` — an operator cannot learn a vendor egress has been wedged for days while newer events queue behind the stuck cursor.
- **Fix:** Record consecutive-failure state (secret-free `failureCount`/`lastError` on `integrationCursors`) and expose it via `integrations.status` and/or emit an anomaly after N consecutive failures. Optionally skip a wedged vendor for a backoff window.

### L5 — Mint double-click race can orphan an active API key
- **File:** `src/chat/admin/ServiceAccountsTab.tsx:134-158` (mint), `:196-200` (row action)
- **Issue:** The guard `if (minting !== null) return;` reads async React state. Two near-simultaneous clicks can both pass before the first re-render, minting an extra key; the second key's plaintext overwrites `minted` state and is never shown, leaving an orphan active key whose secret nobody holds (discoverable only via the key list).
- **Fix:** Guard with a synchronous `useRef` boolean flipped before the `await`, or disable the row action while any mint is in flight. Consider queuing/replacing the minted dialog so a second mint cannot discard an unviewed plaintext.

### L6 — KPI chart axis labels show local time against UTC bucket keys
- **File:** `src/chat/admin/KpiTab.tsx:336-343` (`bucketLabel`)
- **Issue:** Buckets are UTC hour keys (`'2026-06-02T14'`); `bucketLabel` builds a UTC instant via `new Date(`${bucket}:00:00Z`)` then formats with LOCAL getters (`getDate`/`getMonth`/`getHours`). UTC `...T14` displays as `16h` in UTC+2, and a late-night UTC bucket can render the wrong calendar day. Cosmetic (values/cards correct) but misleading on the timeline.
- **Fix:** Use UTC getters (`getUTCDate`/`getUTCMonth`/`getUTCHours`), or convert and label the timezone explicitly. Apply the same convention to `oc-kpi__axis-latest`.

### L7 — `revoke()` has no in-flight guard
- **File:** `src/chat/admin/ServiceAccountsTab.tsx:160-177`
- **Issue:** After the confirm dialog resolves, a fast double-trigger can call `revokeApiKey` twice. Backend idempotency likely makes this harmless, but unlike `mint()` there is intentionally no guard — inconsistent and could surface a transient error or duplicate audit entry.
- **Fix:** Disable the per-key "Révoquer" button while its revoke mutation is in flight (track the in-flight `keyId`), mirroring the mint guard. Low priority if `revokeApiKey` is idempotent server-side.

### L8 — MCP `listAnomalies` `since` filter is a silent no-op
- **Files:** `mcp/src/tools.ts:113-124`, `mcp/src/server.ts:144`, `mcp/src/cli.ts:106-110`; server side `convex/http.ts:226-238`
- **Issue:** Client sends `?since=...`, advertised by server/CLI, but the GET `/api/v1/anomalies` handler reads only `status` and `limit` — `since` is never read. The filter silently does nothing.
- **Fix:** Either add `since` support to the anomalies handler/`anomaliesInternal` query (server-side), or remove the `since` option from `listAnomalies`/`server.ts`/`cli.ts` so the client does not advertise an unsupported filter.

### L9 — `dev.reset` omits several tables from its wipe list
- **File:** `convex/dev.ts:230-264`
- **Issue:** `dev.reset` claims to "wipe app data" but its table list omits `anomalies`, `auditLog`, `integrationCursors`, `projects`, and `instances` (all in `schema.ts`). Detector/agent anomalies, the impersonation audit trail, vendor shipping cursors, and user projects/instances survive a reset. (The live deployment could not be reached during review to confirm leftover dev rows — verify directly.)
- **Fix:** Add `anomalies`, `auditLog`, `integrationCursors`, `projects`, `instances` to the reset table list (already dev-gated). To purge leftover dev service accounts/keys/chats on the live deployment, run a one-off `dev.reset` after confirming the rows, or delete named service accounts via the admin UI revoke + targeted cleanup.

---

## Deferred-acceptable

These are confirmed gaps the reviewers judged acceptable to defer to a later increment (informational/scaffolding/known-deferred). Track them; they are not blockers for this pass.

### D-1 — Custom roles cannot be assigned to human users (increment 2b)
- **Files:** `convex/admin.ts:13-17`, `:51-71`; `convex/schema.ts:74-76`
- **Issue:** `profiles.role` is still the closed union `pending|user|admin`; the RBAC matrix (roles table + `permissionsForRoleKey` + `roleHasPermission`) is consumed only by service-account/API-key principals. The matrix UI lets an admin define a custom role, but it can never be attached to a user.
- **Deferred fix:** When implemented, widen `profiles.role` (widen-migrate-narrow), add an admin assignment mutation validating against the roles table, and resolve human permissions via `permissionsForRoleKey`. Until then, label custom roles as "service-account only" in the UI.

### D-2 — `listRoles` does not seed/merge built-in roles; client overlay can drift
- **Files:** `src/chat/admin/RolesTab.tsx:21-27`, `:76-102`, `:128-153`; `convex/apiKeys.ts:267-284`
- **Issue:** `listRoles` is read-only so it cannot seed; on a fresh deployment the admin cannot edit built-in role permissions until a create/mint side-effect seeds the table. `RolesTab` compensates with a hand-maintained `BUILTIN_BASELINE` that can silently drift from `convex/lib/rbac.ts`.
- **Deferred fix:** Seed built-ins idempotently at first admin load (an admin-gated `ensureRolesSeeded` mutation the tab calls on mount), removing the client overlay and drift risk.

### D-3 — No anomalies viewer UI (and `integrations.status` unconsumed)
- **Files:** `src/chat/AdminSettings.tsx:26-36` (TABS); `convex/anomalies.ts:364-370` (`listAnomalies`)
- **Issue:** No `anomalies` admin tab exists. The `requireAdmin`-gated `listAnomalies` query is fully built but has zero consumers; same for `integrations.status` (its own comment says "for a future Settings panel"). Unwired-but-intended.
- **Deferred fix:** Add an `anomalies` tab consuming `api.anomalies.listAnomalies` (with the resolve action from M2) and an `integrations` status panel consuming `api.integrations.status`.

### D-4 — `traces.read.content` permission is defined-but-inert (D2 scaffolding)
- **Files:** `convex/observability.ts:90-112` (`writeTraceEvent`); `convex/lib/rbac.ts` (`PERMISSIONS.TRACES_READ_CONTENT`)
- **Issue:** `writeTraceEvent` hardcodes `redacted:true` and never consults a capture flag or the `traces.read.content` permission, which is shown in the matrix but enforced nowhere. No code path can produce a non-redacted trace. D2 documents this as revisitable.
- **Deferred fix:** When implemented, add an explicit capture flag to the trace payload, branch redaction in `writeTraceEvent`, and gate raw-content READ in `listEvents`/`recentEventsInternal` on `traces.read.content`. Until then, note in the matrix UI that the permission is not yet enforced.

### D-5 — Langfuse OTLP envelope omits `resource`/`scope`
- **File:** `convex/integrations/langfuse.ts:122-125`
- **Issue:** The OTLP envelope omits `resource` (with `service.name`) and `scope`. Legal per the OTLP spec (all fields optional) so ingestion succeeds, but without `service.name` the spans land under a default/empty service in Langfuse, degrading grouping/discoverability. Informational, no secret/PHI involved.
- **Deferred fix:** Optionally add a constant `resource` block (`service.name: 'openclaw-webchat'`) and minimal `scope` (`name: 'openclaw-convex'`) so shipped spans are attributed to a named service.
