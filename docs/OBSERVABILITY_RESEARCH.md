# Observability & Analysis Platform — Research Synthesis (Actionable)

Companion to `OBSERVABILITY_PLATFORM_PLAN.md`. This consolidates 5 parallel research
streams (Langfuse, Opik, MCP TS SDK, API-key design, RBAC/API-key UX) into concrete
guidance **mapped to our increments**. It is synthesis *against the locked contract*:
where generic best-practice conflicts with our locked decisions (D1–D5) or pinned
module contracts, the contract wins and the override is stated explicitly.

**Direction matters — keep two flows separate:**
- **Outbound (we are a client):** Increment 5 ships spans *to* Opik/Langfuse.
- **Inbound (we are a server):** Spine + Increment 7 — OpenClaw agents call *our*
  `/api/v1/*` with `oc_live_` Bearer keys.

---

## API-key scheme for the spine (Increment 1 / `lib/apikeys.ts` + `lib/apiAuth.ts`)

### What we adopt from the research
- **Display-once.** Plaintext returned exactly once at mint; never persisted, never
  re-retrievable (Stripe/GitHub/OpenAI/Carbon all converge on this). Matches D3.
- **Prefix + last-4 stored in plaintext** for UI identification without revealing the
  secret. Our schema already has `prefix` + `lastFour`.
- **Lifecycle fields:** `lastUsedAt` (bump on each authenticated call — already in
  `lib/apiAuth.ts` contract), optional `expiresAt`, `disabled` for revocation.
- **Revocation states** collapse to our two fields: `disabled: boolean` (manual revoke)
  + `expiresAt` (auto-expiry). No separate state enum needed for the spine.

### What we explicitly do NOT adopt (overrides)
- **NOT bcrypt.** Research agent 4 centers on `bcrypt(cost=12)`. **D3 locks SHA-256
  via Web Crypto** (`crypto.subtle.digest`). Rationale: keys are high-entropy random
  (not user passwords), so a fast hash is appropriate and bcrypt isn't available/clean
  in the Convex runtime. Lookup is by exact hash via the `by_hash` index.
- **NOT the `sakey_prod_webhooks_..._luhn` multi-segment format.** Contract locks
  `oc_live_<base62>`. Environment/service-type is *not* encoded in the key string; it
  is derived from the resolved `serviceAccount` + `roleKey`. (`oc_live_` is the only
  prefix; introduce `oc_test_` only if we ever split deployments.)
- **NOT the SQL DDL.** This is Convex; tables are already pinned in the plan
  (`serviceAccounts`, `apiKeys`). No parallel relational schema.

### Recommended format & flow (concrete)
```
oc_live_<base62>          # e.g. oc_live_7Fq2... ; >=32 base62 chars ≈ 190 bits entropy
prefix   = "oc_live"      # stored plaintext, for grouping/identification
lastFour = secret[-4:]    # stored plaintext, for the console table
hashedKey= sha256_hex(full_plaintext)   # the ONLY persisted secret material
```

**Mint (ACTION only — random + hash are non-deterministic):**
```ts
// lib/apikeys.ts
export function generateApiKey() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const body = base62(bytes);                 // ~32 chars
  const plaintext = `oc_live_${body}`;
  return { plaintext, prefix: "oc_live", lastFour: plaintext.slice(-4) };
}
export async function hashKey(plaintext: string): Promise<string> {
  const data = new TextEncoder().encode(plaintext);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}
```
`apiKeys.mintApiKey` (admin action): generate → hash → `ctx.runMutation` insert
`{serviceAccountId, hashedKey, prefix, lastFour, disabled:false, createdAt, expiresAt?}`
→ **return `{plaintext}` exactly once**.

**Verify (httpAction → `lib/apiAuth.ts`):**
```ts
// authenticateApiKey(ctx, request)
// 1. parse "Authorization: Bearer oc_live_..."   -> 401 if missing/malformed
// 2. hash presented key (SHA-256)
// 3. ctx.runQuery(internal.apiKeys.findByHash, { hash })   (by_hash index)  -> 401 if null
// 4. if key.disabled || (key.expiresAt && key.expiresAt < Date.now()) -> 401
// 5. load serviceAccount; if disabled -> 401
// 6. resolve perms via permissionsForRoleKey(ctx, account.roleKey)
// 7. fire-and-forget bump lastUsedAt
// 8. return { ok, principal: {type:"service", id, roleKey, perms}, key }
// requirePermission(ctx, principal, perm): roleHasPermission(principal.perms, perm) else 403
```
Status discipline (proof routes in the gate): bad/revoked/expired key → **401**;
authenticated but role lacks the permission → **403**.

### Deferred (not spine; do not expand)
- Per-key **rate limiting** (gateway-style 429 + `RateLimit-*` headers) → revisit when
  exposure widens (post inc 7).
- **Per-call audit log table / anomaly materialized views** → these map to Increment 6
  (anomaly) and the existing `traceEvents` writer; the spine's `api.call` trace row is
  the minimal audit primitive. Do not stand up a separate request-log table.

---

## Increment 2 — RBAC matrix UI + Service accounts & API keys UI

Stack is ready: `shadcn` (^4.10), `radix-ui`, `lucide-react`, Tailwind v4 are already
deps. No new UI dependency required. All of this lives in admin-only Convex functions
(D4: **no HTTP route** manages roles/keys; UI calls Convex directly).

### Permission matrix — bind to OUR keys/roles (not generic Org/Project)
- **Columns = our roles:** `pending`, `user`, `admin`, `observer`, `agent` (+ any
  custom roles). Built-in roles get a lock badge and are read-only; custom roles are
  editable/deletable. Show whether each role targets *users* or *service accounts*.
- **Rows = our permission keys**, grouped:
  - **Traces:** `traces.read`, `traces.read.content`, `traces.write`
  - **KPI:** `kpi.read`, `kpi.write`
  - **OpenClaw/Anomaly:** `openclaw.query`, `anomalies.read`, `anomalies.report`
  - **Chats:** `chats.read`
  - **Admin:** `admin.manage` (superset; show `*` roles as all-checked + disabled)
- **Cells:** checkbox/check-icon = granted. For `admin` (`*`) render all cells checked
  and disabled with a tooltip ("granted via `*`"). `traces.read.content` cell should
  carry a PHI warning tooltip (D2: gates raw content).
- **Layout:** sticky header (`position: sticky; top:0; z-10`), frozen first column
  (`sticky; left:0; z-9`), wrap in `overflow-x-auto`. Mobile: collapse to per-role
  expandable cards (permission list with toggles).
- **Custom role editor (modal):** name + description → toggle permission keys grouped
  as above → live "granted permissions" summary. Persisted to `roles` with
  `builtin:false`. Built-in roles immutable.
- **User role assignment** reuses the existing `pending|user|admin` mapping
  (D5 — built-in keys map onto the role→permission model; do not rewrite `access.ts`).

### Service accounts & API keys UI
- **Tabs:** Built-in Roles | Custom Roles | Service Accounts.
- **Service accounts table:** Name · Role (`observer`/`agent`/custom) · Disabled? ·
  Created by · Actions (Edit, Disable, Manage keys). Create modal = name + description
  + role select.
- **API keys table (per account):** Prefix+last-4 (`oc_live · ····7Fq2`, monospace,
  `bg-muted`) · Created · Last used ("Never" / "3 days ago") · Expires (badge if
  <30d / expired) · Status (Active/Revoked/Expired) · Actions (Revoke).
- **Mint modal (show-once flow):**
  1. Form: key name, optional expiry (Never / 30d / 90d / custom).
  2. On create: success modal shows full `oc_live_...` in a read-only monospace box.
  3. Copy-to-clipboard button (icon Copy→Check transition; Sonner-style toast).
  4. Warning callout: "Store this key securely. You will not see it again." (D3).
  5. Closing without copy → confirm ("you'll need to revoke and re-create").
- **Stale-key affordance:** highlight keys with `lastUsedAt` older than ~30d.

---

## Increment 5 — Opik & Langfuse adapters (outbound; ship spans, pull on demand)

### Convex-runtime decision (make this call)
Both vendor SDKs (`opik`, `@langfuse/tracing`) are Node-oriented and pull in batching/
bundling that fights Convex's default V8 isolate. **Recommendation: do NOT use the
vendor SDKs. Use raw `fetch` from a standard Convex action** (Langfuse OTLP/HTTP JSON,
Opik `/api/v1/private/traces`). Benefits: no `"use node";` constraint, no SDK lock-in,
no in-process batch buffer that needs `flush()` before the action freezes. We supply
our own correlation IDs, so SDK convenience buys us little.

### Linking (D1): Convex ↔ vendor by `correlationId`
Convex stores the bounded recent window + KPI rollups and **links out** to the firehose
by `correlationId`. Seed the vendor trace ID deterministically from our `correlationId`
so the link is bidirectional and stable.
- **Langfuse:** `createTraceId(correlationId)` returns a stable ID for the same seed.
  If avoiding the SDK, derive the trace ID by hashing the `correlationId` to the OTLP
  16-byte `traceId` (same seed → same ID).
- **Opik:** set the `TraceWrite.id` (or a deterministic UUID from `correlationId`); use
  `threadId` for multi-turn conversation grouping.

### Langfuse adapter (OTLP/HTTP, no SDK)
- Endpoint: `POST {LANGFUSE_HOST}/api/public/otel/v1/traces`
  (self-host `http://localhost:3000/...`; cloud EU `https://cloud.langfuse.com/...`).
- Headers: `Authorization: Basic base64("pk-lf-…:sk-lf-…")`,
  `Content-Type: application/json`, `x-langfuse-ingestion-version: 4`.
- Body: `ExportTraceServiceRequest` →
  `resourceSpans[].scopeSpans[].spans[]`.
- Span model for a chat turn:
  - root span: `langfuse.trace.name`, `langfuse.user.id`, `langfuse.session.id`
    (= chatId/runId), `parentSpanId = "0000000000000000"`.
  - child generation: `langfuse.observation.type="generation"`,
    `langfuse.observation.model.name`, `.input`, `.output`.
  - child tool/retriever spans as `observation.type` = `tool` / `retriever`.
- **PHI (D2):** by default ship redacted attributes (lengths/hashes/roles/status/
  latency). Only populate `.input`/`.output` raw text when the capture flag +
  `traces.read.content` gate is set.

### Opik adapter (REST, no SDK)
- Endpoints: `POST {OPIK_URL}/api/v1/private/traces` (batch),
  `POST {OPIK_URL}/api/v1/private/spans` (batch), `POST .../traces/{id}` (update).
  Self-host default `http://localhost:5173/api`; cloud `https://www.comet.com/opik/api`.
- Headers: `Authorization: Bearer <OPIK_API_KEY>` (or `x-api-key`), optional
  `workspaceName` (else token-mapped server-side).
- `TraceWrite`: `{ id, projectName, name, startTime(ISO, required), endTime,
  input/output/metadata, tags, threadId }`.
- `SpanWrite`: `{ id, projectName, traceId(required), parentSpanId, name,
  type: "llm"|"tool"|"agent"|"retrieval", startTime(required), endTime,
  input/output, model, provider, usage(token counts), totalEstimatedCost }`.
- Same D2 redaction discipline as Langfuse.

### Config & shape
- Env (Convex deployment): `LANGFUSE_HOST`, `LANGFUSE_PUBLIC_KEY`,
  `LANGFUSE_SECRET_KEY`; `OPIK_URL`, `OPIK_API_KEY`, `OPIK_WORKSPACE` (optional).
  Treat all as bridge/gateway-class secrets (D3 — stay in env, never traced/logged).
- Adapter contract (both): `shipTrace(ctx, { correlationId, ... }): Promise<void>`
  as a Convex **action** (network egress); "pull on demand" = read-only actions that
  `fetch` vendor GET endpoints when the admin opens a trace's external link.
- Either/both can be enabled; if neither configured, adapter is a no-op. Failures must
  not block chat (egress is best-effort; log a redacted warning).

---

## Increment 7 — MCP server + CLI (thin clients over our `/api/v1`, key-auth)

The MCP server is a **stdio** server that proxies **our** `/api/v1` (inbound auth flow),
**not** Opik/Langfuse. It carries an `oc_live_` Bearer key in `Authorization` and lets
OpenClaw agents query traces/KPIs/anomalies as tools.

### Server skeleton (`@modelcontextprotocol/sdk`, Zod, stdio)
```ts
#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE = process.env.OPENCLAW_WEBCHAT_API_URL; // deployment .site origin + /api/v1
const KEY  = process.env.OPENCLAW_WEBCHAT_API_KEY; // oc_live_...
if (!BASE || !KEY) { console.error("OPENCLAW_WEBCHAT_API_URL and _API_KEY required"); process.exit(1); }

const server = new McpServer({ name: "openclaw-webchat-observability", version: "0.1.0" });

async function api(path: string, init?: RequestInit) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) return { content: [{ type: "text", text: `API ${res.status}: ${await res.text()}` }], isError: true };
  return { content: [{ type: "text", text: JSON.stringify(await res.json(), null, 2) }] };
}

server.registerTool("list_traces", {
  title: "List recent traces",
  description: "Recent trace events (key must have traces.read).",
  inputSchema: z.object({
    correlationId: z.string().optional().describe("Filter to one correlation chain"),
    limit: z.number().int().min(1).max(200).optional(),
  }),
}, async ({ correlationId, limit }) => {
  const q = new URLSearchParams();
  if (correlationId) q.set("correlationId", correlationId);
  if (limit) q.set("limit", String(limit));
  return api(`/traces?${q}`);
});

// Add as routes land: get_kpis (kpi.read), query_openclaw (openclaw.query),
// report_anomaly (anomalies.report), list_anomalies (anomalies.read).

async function main() { await server.connect(new StdioServerTransport()); }
main().catch((e) => { console.error(e); process.exit(1); });
```

### Packaging & OpenClaw wiring
- `package.json`: `"type":"module"`, `"bin": { "openclaw-webchat-mcp": "dist/index.js" }`,
  shebang on first line of compiled output; build with `tsc`
  (`module/moduleResolution: NodeNext`, `target: es2022`). Publish → `npx`-runnable.
- OpenClaw config (`~/.openclaw/openclaw.json`):
```json
{
  "mcpServers": {
    "openclaw-webchat": {
      "command": "npx",
      "args": ["-y", "@your-scope/openclaw-webchat-mcp"],
      "env": {
        "OPENCLAW_WEBCHAT_API_URL": "https://<deployment>.convex.site/api/v1",
        "OPENCLAW_WEBCHAT_API_KEY": "oc_live_..."
      }
    }
  }
}
```
- **CLI** = the same thin client (shared `api()` helper) as subcommands
  (`traces list`, `kpi get`, …), same env-var auth. Bearer only in the
  `Authorization` header — never in URLs/query strings.
- **Security:** key lives in env (not committed); each MCP tool maps 1:1 to a
  permission (`traces.read` etc.) enforced server-side by `requirePermission` — so a
  scoped `observer` key naturally can't `report_anomaly`. Stdio transport avoids the
  DNS-rebinding surface of local HTTP MCP servers.

---

## Contract guardrails (verify any code against these)

- **D1** Convex = bounded window + KPI rollups; firehose → Opik/Langfuse; link by
  `correlationId`. Do not store full spans in Convex.
- **D2** Default redacted (lengths/hashes/roles/status/latency). Raw content only
  behind `traces.read.content` + explicit capture flag. Never log gateway tokens /
  device identities / key plaintext.
- **D3** API keys hashed **SHA-256/Web Crypto** only; plaintext shown once. Bridge/
  vendor secrets stay in env. (Overrides research's bcrypt + `sakey_` format.)
- **D4** Roles/keys managed by **admin-only Convex functions, no HTTP route**.
  `/api/v1/*` can *check* permissions, never *manage* them.
- **D5** Extend via `lib/rbac.ts`; don't rewrite `lib/access.ts`. Preserve
  impersonation/bootstrap-OCC/last-admin-guard/audit. `pending|user|admin` map onto
  the role→permission model.
