// HTTP router. @convex-dev/auth requires its OAuth callback / sign-in routes to
// be registered here. This is standard boilerplate; project-specific logic is
// in messages.ts / send.ts / stream.ts / bridge.ts.
//
// REQUIRES A LIVE DEPLOYMENT to serve these routes.

import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { auth } from "./auth";
import { ingest } from "./bridge_ingest";
import { authenticateApiKey, principalHasPermission } from "./lib/apiAuth";
import { PERMISSIONS } from "./lib/rbac";

const http = httpRouter();

// Registers /api/auth/* routes (OAuth start/callback, token exchange).
auth.addHttpRoutes(http);

// Bridge -> Convex ingest. The bridge worker POSTs normalized OpenClaw events
// here (Bearer BRIDGE_INGEST_SECRET) and the httpAction runs internal.stream.*.
// Served at the deployment `.site` origin.
http.route({
  path: "/bridge/ingest",
  method: "POST",
  handler: ingest,
});

// ===========================================================================
// /api/v1 — the key-authed observability API surface.
//
// D4: this surface can only CHECK permissions; roles/keys/service accounts are
// managed by admin-only Convex functions (apiKeys.ts), never here.
// ===========================================================================

/** Small JSON helper for the /api/v1 routes. */
function apiJson(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Liveness probe. No auth, no PHI — just confirms the deployment serves the API.
http.route({
  path: "/api/v1/health",
  method: "GET",
  handler: httpAction(async () => {
    return apiJson({ ok: true, ts: Date.now() });
  }),
});

// Recent trace events for a key-authed principal. The increment-1 proof route:
// authenticate -> require traces.read -> record an `api.call` trace -> return
// recent events. 401 on a bad/disabled/expired key, 403 when the role lacks
// traces.read.
http.route({
  path: "/api/v1/traces",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const startedAt = Date.now();
    const url = new URL(request.url);

    const authResult = await authenticateApiKey(ctx, request);
    if (!authResult.ok) {
      return apiJson({ ok: false, error: authResult.error }, authResult.status);
    }
    const { principal } = authResult;

    if (!principalHasPermission(principal, PERMISSIONS.TRACES_READ)) {
      // Attribute the denied attempt (no PHI) before returning 403.
      await ctx.runMutation(internal.observability.recordEvent, {
        kind: "api.call",
        direction: "inbound",
        principalType: "service",
        principalId: principal.id,
        roleKey: principal.roleKey,
        route: "/api/v1/traces",
        method: "GET",
        status: 403,
        latencyMs: Date.now() - startedAt,
      });
      return apiJson(
        { ok: false, error: "missing permission: traces.read" },
        403,
      );
    }

    // Optional bounded paging (?limit=, ?kind=, ?correlationId=). The internal
    // query is called only AFTER the permission check (httpActions cannot run
    // the check itself). The fetch helper clamps a negative/non-integer limit
    // (L3) so it returns [] instead of 500. M7: correlationId follows a chain.
    const limitParam = url.searchParams.get("limit");
    const kindParam = url.searchParams.get("kind") ?? undefined;
    const correlationId = url.searchParams.get("correlationId") ?? undefined;
    const limit = limitParam ? Number(limitParam) : undefined;
    const events = await ctx.runQuery(
      internal.observability.recentEventsInternal,
      {
        limit: Number.isFinite(limit) ? limit : undefined,
        kind: kindParam,
        correlationId,
      },
    );

    // Record the successful call (metadata only -> redacted by the writer).
    await ctx.runMutation(internal.observability.recordEvent, {
      kind: "api.call",
      direction: "inbound",
      principalType: "service",
      principalId: principal.id,
      roleKey: principal.roleKey,
      route: "/api/v1/traces",
      method: "GET",
      status: 200,
      latencyMs: Date.now() - startedAt,
    });

    return apiJson({ ok: true, events });
  }),
});

// Recent KPI rollups for a key-authed principal (increment 4). Mirrors the
// /api/v1/traces route exactly: authenticate -> require kpi.read -> record an
// `api.call` trace -> return recent rollups. 401 on a bad/disabled/expired key,
// 403 when the role lacks kpi.read.
http.route({
  path: "/api/v1/kpi",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const startedAt = Date.now();
    const url = new URL(request.url);

    const authResult = await authenticateApiKey(ctx, request);
    if (!authResult.ok) {
      return apiJson({ ok: false, error: authResult.error }, authResult.status);
    }
    const { principal } = authResult;

    if (!principalHasPermission(principal, PERMISSIONS.KPI_READ)) {
      // Attribute the denied attempt (no PHI) before returning 403.
      await ctx.runMutation(internal.observability.recordEvent, {
        kind: "api.call",
        direction: "inbound",
        principalType: "service",
        principalId: principal.id,
        roleKey: principal.roleKey,
        route: "/api/v1/kpi",
        method: "GET",
        status: 403,
        latencyMs: Date.now() - startedAt,
      });
      return apiJson({ ok: false, error: "missing permission: kpi.read" }, 403);
    }

    // Optional bounded filtering (?limit=, ?metric=, ?since=). The internal query
    // is called only AFTER the permission check (httpActions cannot run it).
    const limitParam = url.searchParams.get("limit");
    const metricParam = url.searchParams.get("metric") ?? undefined;
    const sinceParam = url.searchParams.get("since") ?? undefined;
    const limit = limitParam ? Number(limitParam) : undefined;
    const rollups = await ctx.runQuery(internal.kpi.kpisInternal, {
      limit: Number.isFinite(limit) ? limit : undefined,
      metric: metricParam,
      since: sinceParam,
    });

    // Record the successful call (metadata only -> redacted by the writer).
    await ctx.runMutation(internal.observability.recordEvent, {
      kind: "api.call",
      direction: "inbound",
      principalType: "service",
      principalId: principal.id,
      roleKey: principal.roleKey,
      route: "/api/v1/kpi",
      method: "GET",
      status: 200,
      latencyMs: Date.now() - startedAt,
    });

    return apiJson({ ok: true, rollups });
  }),
});

// ===========================================================================
// Increment 6 — anomalies + heartbeat + OpenClaw query.
//
// All four routes copy the /api/v1/traces spine EXACTLY: authenticate (401 on a
// bad/disabled/expired key) -> require a permission (403 + an attributed deny
// trace) -> record a successful `api.call` trace -> return. POST routes parse +
// validate the body AFTER the permission check (400 on a bad body) so an invalid
// payload can never reach an internal mutation's validator (which would 500).
// ===========================================================================

// Recent anomalies for a key-authed principal. Mirrors /api/v1/traces:
// authenticate -> require anomalies.read -> record an `api.call` trace -> return.
http.route({
  path: "/api/v1/anomalies",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const startedAt = Date.now();
    const url = new URL(request.url);

    const authResult = await authenticateApiKey(ctx, request);
    if (!authResult.ok) {
      return apiJson({ ok: false, error: authResult.error }, authResult.status);
    }
    const { principal } = authResult;

    if (!principalHasPermission(principal, PERMISSIONS.ANOMALIES_READ)) {
      await ctx.runMutation(internal.observability.recordEvent, {
        kind: "api.call",
        direction: "inbound",
        principalType: "service",
        principalId: principal.id,
        roleKey: principal.roleKey,
        route: "/api/v1/anomalies",
        method: "GET",
        status: 403,
        latencyMs: Date.now() - startedAt,
      });
      return apiJson(
        { ok: false, error: "missing permission: anomalies.read" },
        403,
      );
    }

    // Optional bounded filtering (?status=, ?limit=, ?since=). The internal
    // query runs only AFTER the permission check (httpActions cannot run it).
    // L8: `since` is a numeric ms watermark (keeps at >= since). L3: a negative/
    // non-integer ?limit is clamped by the fetch helper (returns [] not 500).
    const statusParam = url.searchParams.get("status");
    const status =
      statusParam === "open" ||
      statusParam === "acknowledged" ||
      statusParam === "resolved"
        ? statusParam
        : undefined;
    const limitParam = url.searchParams.get("limit");
    const limit = limitParam ? Number(limitParam) : undefined;
    const sinceParam = url.searchParams.get("since");
    const since = sinceParam !== null ? Number(sinceParam) : undefined;
    const anomalies = await ctx.runQuery(internal.anomalies.anomaliesInternal, {
      status,
      limit: Number.isFinite(limit) ? limit : undefined,
      since: since !== undefined && Number.isFinite(since) ? since : undefined,
    });

    await ctx.runMutation(internal.observability.recordEvent, {
      kind: "api.call",
      direction: "inbound",
      principalType: "service",
      principalId: principal.id,
      roleKey: principal.roleKey,
      route: "/api/v1/anomalies",
      method: "GET",
      status: 200,
      latencyMs: Date.now() - startedAt,
    });

    return apiJson({ ok: true, anomalies });
  }),
});

// Report an anomaly OR a self-repair action taken (key-authed). Mirrors the
// /api/v1/traces spine: authenticate -> require anomalies.report -> validate
// body -> record an `api.call` trace -> insert the source:"agent" anomaly.
http.route({
  path: "/api/v1/anomalies",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const startedAt = Date.now();

    const authResult = await authenticateApiKey(ctx, request);
    if (!authResult.ok) {
      return apiJson({ ok: false, error: authResult.error }, authResult.status);
    }
    const { principal } = authResult;

    if (!principalHasPermission(principal, PERMISSIONS.ANOMALIES_REPORT)) {
      await ctx.runMutation(internal.observability.recordEvent, {
        kind: "api.call",
        direction: "inbound",
        principalType: "service",
        principalId: principal.id,
        roleKey: principal.roleKey,
        route: "/api/v1/anomalies",
        method: "POST",
        status: 403,
        latencyMs: Date.now() - startedAt,
      });
      return apiJson(
        { ok: false, error: "missing permission: anomalies.report" },
        403,
      );
    }

    // Parse + validate the body AFTER the permission check so a bad payload can
    // never reach the internal mutation's validator (which would 500).
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return apiJson({ ok: false, error: "invalid JSON body" }, 400);
    }
    const b = (body ?? {}) as Record<string, unknown>;
    const kind = typeof b.kind === "string" ? b.kind : undefined;
    const severity =
      b.severity === "info" || b.severity === "warn" || b.severity === "critical"
        ? b.severity
        : undefined;
    const message = typeof b.message === "string" ? b.message : undefined;
    if (!kind || !severity || !message) {
      return apiJson(
        {
          ok: false,
          error:
            "body requires kind:string, severity:info|warn|critical, message:string",
        },
        400,
      );
    }
    const correlationId =
      typeof b.correlationId === "string" ? b.correlationId : undefined;
    // `evidence` must be a JSON STRING (D2: non-PHI). Accept a provided string by
    // parsing it back to an object (so we can fold in attribution), or take an
    // object directly; reject other types. Reporter attribution (the calling
    // service account's non-PHI id) is merged into `evidence.reportedBy` — NOT
    // into `resolvedBy`, which is reserved for resolution-time attribution.
    let evidenceObj: Record<string, unknown> = {};
    if (typeof b.evidence === "string") {
      try {
        const parsed = JSON.parse(b.evidence);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          evidenceObj = parsed as Record<string, unknown>;
        } else {
          evidenceObj = { value: parsed };
        }
      } catch {
        // Not JSON: keep the raw string under a stable key (still non-PHI bound).
        evidenceObj = { value: b.evidence };
      }
    } else if (
      b.evidence !== undefined &&
      b.evidence !== null &&
      typeof b.evidence === "object" &&
      !Array.isArray(b.evidence)
    ) {
      evidenceObj = b.evidence as Record<string, unknown>;
    } else if (b.evidence !== undefined && b.evidence !== null) {
      return apiJson({ ok: false, error: "evidence must be a JSON object/string" }, 400);
    }
    evidenceObj.reportedBy = principal.id;
    let evidence: string | undefined;
    try {
      evidence = JSON.stringify(evidenceObj);
    } catch {
      return apiJson({ ok: false, error: "evidence not serializable" }, 400);
    }

    const result = await ctx.runMutation(
      internal.anomalies.reportAnomalyInternal,
      {
        kind,
        severity,
        message,
        correlationId,
        evidence,
      },
    );

    await ctx.runMutation(internal.observability.recordEvent, {
      kind: "api.call",
      direction: "inbound",
      principalType: "service",
      principalId: principal.id,
      roleKey: principal.roleKey,
      route: "/api/v1/anomalies",
      method: "POST",
      status: 200,
      latencyMs: Date.now() - startedAt,
    });

    return apiJson({ ok: true, id: result.id });
  }),
});

// Resolve / acknowledge an anomaly (key-authed) — a self-repair surface so an
// OpenClaw agent can clear an anomaly it has handled, bounding the open set.
// Mirrors the /api/v1/traces spine: authenticate -> require anomalies.report ->
// validate body -> record an `api.call` trace -> resolve. The runMutation is
// wrapped in try/catch so a garbage anomalyId (which v.id() would reject -> 500)
// returns a 400 instead, mirroring the body-validation discipline.
http.route({
  path: "/api/v1/anomalies/resolve",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const startedAt = Date.now();

    const authResult = await authenticateApiKey(ctx, request);
    if (!authResult.ok) {
      return apiJson({ ok: false, error: authResult.error }, authResult.status);
    }
    const { principal } = authResult;

    if (!principalHasPermission(principal, PERMISSIONS.ANOMALIES_REPORT)) {
      await ctx.runMutation(internal.observability.recordEvent, {
        kind: "api.call",
        direction: "inbound",
        principalType: "service",
        principalId: principal.id,
        roleKey: principal.roleKey,
        route: "/api/v1/anomalies/resolve",
        method: "POST",
        status: 403,
        latencyMs: Date.now() - startedAt,
      });
      return apiJson(
        { ok: false, error: "missing permission: anomalies.report" },
        403,
      );
    }

    // Parse + validate the body AFTER the permission check.
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return apiJson({ ok: false, error: "invalid JSON body" }, 400);
    }
    const b = (body ?? {}) as Record<string, unknown>;
    const anomalyId =
      typeof b.anomalyId === "string" ? b.anomalyId : undefined;
    const status =
      b.status === "resolved" || b.status === "acknowledged"
        ? b.status
        : undefined;
    if (b.status !== undefined && status === undefined) {
      return apiJson(
        { ok: false, error: "status must be resolved|acknowledged" },
        400,
      );
    }
    if (!anomalyId) {
      return apiJson({ ok: false, error: "body requires anomalyId:string" }, 400);
    }

    // Resolve; a malformed id makes v.id() reject inside the mutation, which
    // would 500 — contain it and return 400 (the route never 500s on input).
    let result: { ok: boolean };
    try {
      result = await ctx.runMutation(internal.anomalies.resolveAnomalyInternal, {
        anomalyId: anomalyId as Id<"anomalies">,
        status,
        // Non-PHI resolution attribution: the calling service account's id.
        resolvedBy: principal.id,
      });
    } catch {
      return apiJson({ ok: false, error: "invalid anomalyId" }, 400);
    }

    await ctx.runMutation(internal.observability.recordEvent, {
      kind: "api.call",
      direction: "inbound",
      principalType: "service",
      principalId: principal.id,
      roleKey: principal.roleKey,
      route: "/api/v1/anomalies/resolve",
      method: "POST",
      status: 200,
      latencyMs: Date.now() - startedAt,
    });

    return apiJson({ ok: result.ok });
  }),
});

// Heartbeat summary (key-authed) so an OpenClaw heartbeat learns whether
// anomalies appeared -> can self-repair. Mirrors /api/v1/traces:
// authenticate -> require anomalies.read -> record an `api.call` trace -> return.
http.route({
  path: "/api/v1/heartbeat",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const startedAt = Date.now();

    const authResult = await authenticateApiKey(ctx, request);
    if (!authResult.ok) {
      return apiJson({ ok: false, error: authResult.error }, authResult.status);
    }
    const { principal } = authResult;

    if (!principalHasPermission(principal, PERMISSIONS.ANOMALIES_READ)) {
      await ctx.runMutation(internal.observability.recordEvent, {
        kind: "api.call",
        direction: "inbound",
        principalType: "service",
        principalId: principal.id,
        roleKey: principal.roleKey,
        route: "/api/v1/heartbeat",
        method: "GET",
        status: 403,
        latencyMs: Date.now() - startedAt,
      });
      return apiJson(
        { ok: false, error: "missing permission: anomalies.read" },
        403,
      );
    }

    const heartbeat = await ctx.runQuery(
      internal.anomalies.heartbeatInternal,
      {},
    );

    await ctx.runMutation(internal.observability.recordEvent, {
      kind: "api.call",
      direction: "inbound",
      principalType: "service",
      principalId: principal.id,
      roleKey: principal.roleKey,
      route: "/api/v1/heartbeat",
      method: "GET",
      status: 200,
      latencyMs: Date.now() - startedAt,
    });

    return apiJson({ ok: true, heartbeat });
  }),
});

// Query OpenClaw via the bridge (key-authed). Mirrors /api/v1/traces:
// authenticate -> require openclaw.query -> validate body -> record an
// `api.call` trace -> run the action. The trace is recorded status 200 (the
// request was authed + handled) even when the bridge is unconfigured/unreachable
// — the bridge outcome rides in the body ({ ok:false, reason }) so a no-op never
// feeds the API-error-ratio anomaly detector.
http.route({
  path: "/api/v1/openclaw/query",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const startedAt = Date.now();

    const authResult = await authenticateApiKey(ctx, request);
    if (!authResult.ok) {
      return apiJson({ ok: false, error: authResult.error }, authResult.status);
    }
    const { principal } = authResult;

    if (!principalHasPermission(principal, PERMISSIONS.OPENCLAW_QUERY)) {
      await ctx.runMutation(internal.observability.recordEvent, {
        kind: "api.call",
        direction: "inbound",
        principalType: "service",
        principalId: principal.id,
        roleKey: principal.roleKey,
        route: "/api/v1/openclaw/query",
        method: "POST",
        status: 403,
        latencyMs: Date.now() - startedAt,
      });
      return apiJson(
        { ok: false, error: "missing permission: openclaw.query" },
        403,
      );
    }

    // Parse + validate the body AFTER the permission check.
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return apiJson({ ok: false, error: "invalid JSON body" }, 400);
    }
    const b = (body ?? {}) as Record<string, unknown>;
    const question = typeof b.question === "string" ? b.question : undefined;
    const payload = b.payload;
    if (question === undefined && payload === undefined) {
      return apiJson(
        { ok: false, error: "body requires question:string and/or payload" },
        400,
      );
    }

    // An httpAction CAN runAction. The action degrades gracefully (never throws)
    // when the bridge env is unset/unreachable -> { ok:false, reason }.
    const result = await ctx.runAction(internal.openclaw.queryOpenClaw, {
      question,
      payload,
    });

    // Record the call as handled (200) regardless of the bridge outcome (see the
    // route comment): a graceful bridge no-op must not inflate the error ratio.
    await ctx.runMutation(internal.observability.recordEvent, {
      kind: "api.call",
      direction: "inbound",
      principalType: "service",
      principalId: principal.id,
      roleKey: principal.roleKey,
      route: "/api/v1/openclaw/query",
      method: "POST",
      status: 200,
      latencyMs: Date.now() - startedAt,
    });

    // 200 envelope; the bridge result (including ok:false/reason) rides inside.
    return apiJson(result);
  }),
});

export default http;
