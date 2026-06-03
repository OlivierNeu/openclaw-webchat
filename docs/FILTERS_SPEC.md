# Filtering & Time-Range — Contract (UI ↔ Convex ↔ /api/v1)

A single, reusable filter model across the admin lists AND the key-authed API.
Three agents implement against this: BACKEND (convex queries + /api/v1 + lib),
FRONTEND (reusable pickers + wire every tab), MCP (new query params on tools/CLI).

## Filter model (shared shape)

A list query accepts an optional `filter`:
```ts
type Filter = {
  q?: string;                 // case-insensitive substring over a resource's searchable fields
  from?: number; to?: number; // time range on the row's time field (epoch ms), inclusive
  // structured "quick" field filters (per-resource subset; all optional, ANDed):
  kind?: string; status?: number; statusClass?: "2xx"|"4xx"|"5xx";
  direction?: string; principalType?: string; roleKey?: string;
  severity?: string; source?: string; anomalyStatus?: string;
  action?: string; impersonated?: boolean; resource?: string;
  role?: string; mode?: string; disabled?: boolean;
  // advanced predicate builder (Traces + Audit), ANDed, evaluated in-memory:
  advanced?: Array<{ field: string; op: Op; value: string | number | boolean }>;
};
type Op = "eq" | "neq" | "contains" | "gt" | "gte" | "lt" | "lte";
```
Evaluated over the bounded recent window each query already reads. Time range
SHOULD use the existing `by_at` index for the lower bound where practical, then
in-memory for `to` + structured + advanced + `q`. Keep all scans bounded.

## Per-resource searchable fields + applicable filters

| Resource (query) | time field | `q` searches | quick filters | advanced? | API? |
|---|---|---|---|---|---|
| Traces (`observability.listEvents` / `recentEventsInternal`) | `at` | kind, principalId, roleKey, route, correlationId | kind, statusClass, principalType, direction, roleKey | **yes** | `/api/v1/traces` |
| Anomalies (`anomalies.listAnomalies` / `anomaliesInternal`) | `at` | message, kind, correlationId | anomalyStatus, severity, source, kind | no | `/api/v1/anomalies` |
| Audit (`admin.listAudit`) | `at` | action, realLabel, targetLabel, resourceId | action, impersonated, resource | **yes** | — (admin only) |
| Users (`admin.listUsers`) | — | email, name, canonical | role | no | — |
| Groups (`admin.listGroups`) | — | name, instanceName | mode | no | — |
| Service accounts (`apiKeys.listServiceAccounts`) | — | name | role, disabled | no | — |
| KPI (`kpi.listKpis`) | `bucket` (hour) | — | metric | no | `/api/v1/kpi` |

## /api/v1 query params (the consumable API — TraceS, Anomalies, KPI)

All three GET routes accept (in addition to existing `limit`):
- `q` — substring.
- `from`, `to` — **epoch ms (numeric) OR a Grafana-style relative token**: `now`,
  `now-<N><unit>` where unit ∈ `s|m|h|d|w` (e.g. `from=now-24h&to=now`). A shared
  parser in `convex/lib/timeRange.ts` resolves tokens → ms at request time.
- structured field params for that resource (traces: `kind`,`status`,`statusClass`,`direction`,`principalType`,`roleKey`,`correlationId`; anomalies: `status`(=anomalyStatus),`severity`,`source`,`kind`,`since`(kept, = from); kpi: `metric`).
- Advanced predicate DSL is NOT exposed over HTTP (the structured params + `q` cover practical agent use); document this. The UI advanced builder maps to the admin query's `advanced` arg only.
Every filtered call is still traced (`api.call`) exactly as today; 401/403 unchanged.

## Reusable FRONTEND primitives (build once, use everywhere)

- `src/chat/admin/filters/TimeRangePicker.tsx` — **Grafana-style**: a popover with
  (a) a quick relative list (Last 5m/15m/30m/1h/3h/6h/12h/24h/2d/7d/30d/90d) with
  search, and (b) an Absolute panel (From/To `datetime-local` inputs). Value:
  `type TimeRange = { kind:"relative"; from:string /* now-24h */; to:string /* now */ } | { kind:"absolute"; from:number; to:number }`.
  Export `resolveRange(r): {from:number; to:number}` (relative re-resolves to NOW each call so live data stays live). The trigger button shows the human label (e.g. "Dernières 24 heures").
- `src/chat/admin/filters/FilterBar.tsx` — a search `<Input>` + a slot for quick
  `<Select>` filters + an optional TimeRangePicker + a "Réinitialiser" clear. Generic, token-styled, matches the admin house style. Place ABOVE the DataTableShell/table.
- `src/chat/admin/filters/AdvancedFilter.tsx` — predicate builder (rows of field
  `<Select>` + op `<Select>` + value `<Input>`, add/remove, ANDed). Collapsible
  ("Filtre avancé"). Emits `Array<{field,op,value}>`. Used by Traces + Audit.
- A tiny `src/chat/admin/filters/types.ts` (the Filter/Op/TimeRange types) + a pure
  client-side `applyAdvanced`/`matchesQuick` helper if any list filters client-side.

Where a list is backed by a query, pass the filter to the query (server-side); where
trivial, client-side filtering over the loaded rows is acceptable (document which).

## Also (Image #15)
- Service-account **key "Créée"** column: show date **+ time** (`toLocaleString("fr-FR")`, not `toLocaleDateString`). Apply the same date+time to other "created"/"date" columns where only a date shows and a time is useful (audit/anomalies/traces already use toLocaleString).

## Non-goals / keep bounded
- No new heavy deps (no date-lib, no query-DSL lib). Native `datetime-local` + small helpers.
- All server filtering stays within the existing bounded windows; never widen a `.collect()`.
- Preserve D2/D5 (no PHI surfaced by `q`/advanced beyond already-redacted metadata).
