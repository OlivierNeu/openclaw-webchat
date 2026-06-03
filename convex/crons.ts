// Scheduled jobs.
//
// Retention sweep (D1): once a day, delete trace events older than
// TRACE_RETENTION_DAYS (default 14). purgeOldTraces processes one bounded batch
// and re-schedules itself if a backlog remains, so a single daily trigger
// drains any accumulation without exceeding mutation limits.
//
// KPI rollups (D1, increment 4): once an hour, aggregate the bounded recent
// trace window into the small, long-lived kpiRollups table. rollupKpis is
// idempotent (it REPLACES per-bucket values), so an overlapping recompute never
// double-counts.

import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Daily at 03:00 UTC (quiet hour). Use crons.cron (not the daily/weekly
// helpers) per the Convex cron guideline.
crons.cron(
  "purge old trace events",
  "0 3 * * *",
  internal.observability.purgeOldTraces,
  {},
);

// Hourly at minute 0. Recomputes KPI rollups for the recent hour buckets.
crons.cron("rollup kpis", "0 * * * *", internal.kpi.rollupKpis, {});

// Outbound trace shipping (increment 5): every 5 minutes, flush NEW trace events
// to whichever vendors (Langfuse/Opik) are configured via deployment env. A
// vendor with no env is a per-vendor no-op; the action never throws into the
// cron (best-effort egress — see integrations/ship.ts).
crons.interval(
  "flush traces to vendors",
  { minutes: 5 },
  internal.integrations.ship.flushToVendors,
  {},
);

// Anomaly detection (increment 6): every 5 minutes, scan the bounded recent
// trace window and UPSERT anomalies (one OPEN row per kind — de-duped, never
// double-inserted across runs). Bounded scan; safe to overlap. Feeds the
// heartbeat so an OpenClaw agent can learn of anomalies and self-repair.
crons.interval(
  "detect anomalies",
  { minutes: 5 },
  internal.anomalies.detectAnomalies,
  {},
);

export default crons;
