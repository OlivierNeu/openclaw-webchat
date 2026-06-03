/**
 * Shared tool logic for both the MCP server and the CLI.
 *
 * Each function here maps 1:1 to a PLANNED /api/v1 route (see
 * docs/OBSERVABILITY_PLATFORM_PLAN.md). The package is a thin proxy: it builds
 * against the plan even though some routes only land in increments 4/6. Whether
 * a route is deployed is a *runtime* concern — a not-yet-deployed route returns
 * the API's own response/error (e.g. 404) which we surface, rather than
 * crashing the server.
 *
 * Server-side `requirePermission` enforces the key's scope, so a tool call to a
 * route the key lacks permission for naturally returns 403.
 */

import { z } from "zod";
import { apiFetch, type ApiFetchOptions, type Config } from "./config.js";

export interface ListTracesArgs {
  limit?: number;
  kind?: string;
  correlationId?: string;
}

export interface GetKpiArgs {
  metric?: string;
  since?: string;
}

export interface QueryOpenClawArgs {
  /** Matches the server contract: POST /api/v1/openclaw/query reads `question`. */
  question?: string;
  /** Free-form passthrough the route forwards to the bridge action. */
  payload?: unknown;
}

export interface ListAnomaliesArgs {
  limit?: number;
  since?: string;
  status?: string;
}

export interface ReportAnomalyArgs {
  kind: string;
  /** Server accepts only info|warn|critical (400 otherwise). */
  severity: "info" | "warn" | "critical";
  message: string;
  correlationId?: string;
  /** Maps to the server's `evidence` field (non-PHI structured context). */
  evidence?: unknown;
}

/**
 * Shared MCP input schemas, kept here (not in server.ts) so they can be unit
 * tested without importing server.ts/cli.ts — both of which call `main()` at
 * module load. server.ts spreads these into `registerTool({ inputSchema })`.
 */

export const queryOpenClawInput = {
  question: z.string().optional().describe("Prompt/query text."),
  payload: z.unknown().optional()
    .describe("Free-form passthrough forwarded to the bridge."),
} as const;

export const reportAnomalyInput = {
  kind: z.string().describe("Anomaly kind/type (required)."),
  severity: z.enum(["info", "warn", "critical"])
    .describe("Severity: 'info' | 'warn' | 'critical' (required)."),
  message: z.string().describe("Human-readable description (required)."),
  correlationId: z.string().optional()
    .describe("Correlation chain this anomaly relates to."),
  evidence: z.unknown().optional()
    .describe("Free-form structured, non-PHI evidence."),
} as const;

/** Build a query string from defined values only (Bearer is never in the URL). */
function qs(params: Record<string, string | number | undefined>): string {
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      sp.set(key, String(value));
    }
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

/** GET /api/v1/health — liveness probe (no auth needed, but we send the key). */
export function health(
  config: Config,
  options?: ApiFetchOptions,
): Promise<unknown> {
  return apiFetch(config, "/health", {}, options);
}

/** GET /api/v1/traces — recent trace events. Requires `traces.read`. */
export function listTraces(
  config: Config,
  args: ListTracesArgs = {},
  options?: ApiFetchOptions,
): Promise<unknown> {
  const query = qs({
    limit: args.limit,
    kind: args.kind,
    correlationId: args.correlationId,
  });
  return apiFetch(config, `/traces${query}`, {}, options);
}

/** GET /api/v1/kpi — KPI rollups (increment 4). Requires `kpi.read`. */
export function getKpi(
  config: Config,
  args: GetKpiArgs = {},
  options?: ApiFetchOptions,
): Promise<unknown> {
  const query = qs({ metric: args.metric, since: args.since });
  return apiFetch(config, `/kpi${query}`, {}, options);
}

/**
 * POST /api/v1/openclaw/query — query OpenClaw via the bridge (increment 6).
 * Requires `openclaw.query`. Sends `{ question, payload }` (the only keys the
 * server route reads; it 400s when both are undefined).
 */
export function queryOpenClaw(
  config: Config,
  args: QueryOpenClawArgs = {},
  options?: ApiFetchOptions,
): Promise<unknown> {
  return apiFetch(
    config,
    "/openclaw/query",
    { method: "POST", body: JSON.stringify(args) },
    options,
  );
}

/** GET /api/v1/anomalies — detected anomalies (increment 6). Requires `anomalies.read`. */
export function listAnomalies(
  config: Config,
  args: ListAnomaliesArgs = {},
  options?: ApiFetchOptions,
): Promise<unknown> {
  const query = qs({
    limit: args.limit,
    since: args.since,
    status: args.status,
  });
  return apiFetch(config, `/anomalies${query}`, {}, options);
}

/**
 * POST /api/v1/anomalies — report an anomaly (increment 6). Requires
 * `anomalies.report`. Sends `evidence` (the server's field name), not `details`.
 */
export function reportAnomaly(
  config: Config,
  args: ReportAnomalyArgs,
  options?: ApiFetchOptions,
): Promise<unknown> {
  return apiFetch(
    config,
    "/anomalies",
    { method: "POST", body: JSON.stringify(args) },
    options,
  );
}
