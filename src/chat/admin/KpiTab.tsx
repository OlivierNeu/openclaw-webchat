import { useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../convexApi";
import type { Id } from "../convexApi";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// "KPI" tab — the observability dashboard (increment 4). Reads
// api.kpi.listKpis, an admin query returning the SMALL, long-lived per-hour
// rollups (newest bucket first). All visualization is hand-rolled SVG/CSS over
// that bounded data — no chart dependency (the hourly buckets are tiny).
//
// Two non-obvious points:
//  - `listKpis`' `limit` counts ROWS, not buckets, and the rollup writes ALL
//    metrics for EVERY bucket. So "last N buckets" needs limit = N * (metric
//    count). See `bucketsToLimit` below.
//  - The flat {bucket, metric, value} rows are pivoted client-side into one
//    ascending-by-bucket series per metric (ISO hour strings sort
//    lexicographically == chronologically, so a string sort is correct).

type KpiRollupView = {
  _id: Id<"kpiRollups">;
  bucket: string;
  metric: string;
  value: number;
  dims: string | null;
};

// Metric → display config. Single source of truth for label, unit hint, group
// and the error-color flag. Drives card order and chart styling; mirrors the
// KPI_METRICS contract in convex/kpi.ts. Any metric the backend returns that is
// absent here is dropped from the dashboard (forward-compatible).
type MetricGroup = "API" | "OpenClaw" | "Chat" | "Assistant";
type MetricConfig = {
  metric: string;
  label: string;
  unit: string;
  group: MetricGroup;
  isError: boolean;
};

const METRIC_CONFIG: MetricConfig[] = [
  { metric: "api.calls", label: "Appels API", unit: "/h", group: "API", isError: false },
  { metric: "api.errors", label: "Erreurs API", unit: "/h", group: "API", isError: true },
  {
    metric: "api.latency.avg_ms",
    label: "Latence moyenne",
    unit: "ms",
    group: "API",
    isError: false,
  },
  {
    metric: "openclaw.ingest",
    label: "Ingestion OpenClaw",
    unit: "/h",
    group: "OpenClaw",
    isError: false,
  },
  { metric: "chat.send", label: "Messages envoyés", unit: "/h", group: "Chat", isError: false },
  {
    metric: "assistant.stream.errors",
    label: "Erreurs de stream",
    unit: "/h",
    group: "Assistant",
    isError: true,
  },
];

// Number of distinct metrics the rollup writes per bucket. limit (rows) for the
// backend = wanted buckets * this. Kept in sync with METRIC_CONFIG.
const METRIC_COUNT = METRIC_CONFIG.length;

// Group render order.
const GROUP_ORDER: MetricGroup[] = ["API", "OpenClaw", "Chat", "Assistant"];

// Bucket-window presets. The control is a bucket count; we translate to a row
// limit for the backend (which caps at MAX_LIST_LIMIT = 1000, so 168 buckets
// over-asks slightly and the OLDEST bucket may come back partial — cosmetic on
// the chart, never affecting the latest-bucket cards which always return first).
const BUCKET_OPTIONS = [
  { value: "24", label: "24 dernières heures" },
  { value: "72", label: "72 dernières heures" },
  { value: "168", label: "7 derniers jours" },
] as const;
type BucketValue = (typeof BUCKET_OPTIONS)[number]["value"];

function bucketsToLimit(buckets: number): number {
  return buckets * METRIC_COUNT;
}

type Point = { bucket: string; value: number };

export function KpiTab() {
  const [bucketsChoice, setBucketsChoice] = useState<BucketValue>("24");
  const buckets = Number(bucketsChoice);

  const rollups = useQuery(api.kpi.listKpis, {
    limit: bucketsToLimit(buckets),
  }) as KpiRollupView[] | undefined;

  // Pivot the flat rows into one ascending-by-bucket series per metric. Sorting
  // bucket strings ascending == chronological (ISO hour strings). The series is
  // also clipped to the wanted bucket count so a small over-fetch (when filtered
  // by row limit) does not stretch the chart x-axis.
  const seriesByMetric = useMemo(() => {
    const map = new Map<string, Point[]>();
    for (const r of rollups ?? []) {
      const list = map.get(r.metric) ?? [];
      list.push({ bucket: r.bucket, value: r.value });
      map.set(r.metric, list);
    }
    for (const [metric, list] of map) {
      list.sort((a, b) => (a.bucket < b.bucket ? -1 : a.bucket > b.bucket ? 1 : 0));
      // Keep only the most recent `buckets` points (the tail after asc sort).
      if (list.length > buckets) map.set(metric, list.slice(list.length - buckets));
    }
    return map;
  }, [rollups, buckets]);

  // Keep the toolbar mounted across loading/empty/data states: Convex returns
  // undefined while args change (e.g. switching the window), so an early return
  // without the toolbar would make the selector flicker away mid-interaction.
  const header = (
    <>
      <p className="oc-admin__hint">
        Indicateurs agrégés par heure à partir des traces expurgées (métadonnées
        non-PHI uniquement). Mise à jour en direct (useQuery) — le rollup tourne
        chaque heure.
      </p>
      <Toolbar value={bucketsChoice} onChange={setBucketsChoice} />
    </>
  );

  if (rollups === undefined) {
    return (
      <>
        {header}
        <p className="oc-admin__hint">Chargement des KPI…</p>
      </>
    );
  }

  if (rollups.length === 0) {
    return (
      <>
        {header}
        <p className="oc-admin__hint">
          Aucune donnée KPI — le rollup tourne chaque heure ; lance-le ou attends.
        </p>
      </>
    );
  }

  return (
    <>
      {header}

      {GROUP_ORDER.map((group) => {
        const configs = METRIC_CONFIG.filter((c) => c.group === group);
        // Skip a group entirely if none of its metrics have any data yet.
        const hasAny = configs.some((c) => (seriesByMetric.get(c.metric) ?? []).length > 0);
        if (!hasAny) return null;
        return (
          <section key={group} className="oc-kpi__group">
            <h2 className="oc-kpi__group-title">{group}</h2>
            <div className="oc-kpi__grid">
              {configs.map((cfg) => (
                <MetricCard
                  key={cfg.metric}
                  config={cfg}
                  series={seriesByMetric.get(cfg.metric) ?? []}
                />
              ))}
            </div>
          </section>
        );
      })}
    </>
  );
}

function Toolbar({
  value,
  onChange,
}: {
  value: BucketValue;
  onChange: (v: BucketValue) => void;
}) {
  return (
    <div className="oc-kpi__toolbar">
      <Select value={value} onValueChange={(v) => onChange(v as BucketValue)}>
        <SelectTrigger size="sm" className="w-48">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {BUCKET_OPTIONS.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function MetricCard({
  config,
  series,
}: {
  config: MetricConfig;
  series: Point[];
}) {
  // Latest bucket value = last point after ascending sort.
  const latest = series.length > 0 ? series[series.length - 1] : null;
  const latestValue = latest ? latest.value : 0;

  return (
    <Card size="sm" className="oc-kpi__card">
      <CardHeader>
        <CardTitle className="oc-kpi__card-title">{config.label}</CardTitle>
        <CardDescription className="oc-kpi__card-metric">
          <code>{config.metric}</code>
        </CardDescription>
      </CardHeader>
      <CardContent className="oc-kpi__card-body">
        <div className="oc-kpi__value-row">
          <span
            className={
              "oc-kpi__value" + (config.isError && latestValue > 0 ? " oc-kpi__value--error" : "")
            }
          >
            {formatValue(latestValue)}
          </span>
          <span className="oc-kpi__unit">{config.unit}</span>
        </div>
        <BarChart series={series} isError={config.isError} unit={config.unit} />
        <div className="oc-kpi__axis">
          {latest ? (
            <span className="oc-kpi__axis-latest">
              dernier&nbsp;: {bucketLabel(latest.bucket)}
            </span>
          ) : (
            <span className="oc-kpi__muted">aucune donnée</span>
          )}
          <span className="oc-kpi__muted">{series.length} h</span>
        </div>
      </CardContent>
    </Card>
  );
}

// Hand-rolled SVG bar chart over the recent buckets. x = hour bucket, y = value.
// Fixed viewBox; bars scale to the series max. A <title> on each bar gives a
// native hover tooltip. All-zero / single / empty series are guarded so the
// math never divides by zero or produces NaN heights.
const CHART_W = 240;
const CHART_H = 48;
const BAR_GAP = 1;

function BarChart({
  series,
  isError,
  unit,
}: {
  series: Point[];
  isError: boolean;
  unit: string;
}) {
  if (series.length === 0) {
    return <div className="oc-kpi__chart oc-kpi__chart--empty" aria-hidden />;
  }

  const max = series.reduce((m, p) => (p.value > m ? p.value : m), 0);
  const n = series.length;
  const slot = CHART_W / n;
  const barWidth = Math.max(slot - BAR_GAP, 1);

  return (
    <svg
      className="oc-kpi__chart"
      viewBox={`0 0 ${CHART_W} ${CHART_H}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={`Série horaire (max ${formatValue(max)} ${unit})`}
    >
      {series.map((p, i) => {
        // Guard max === 0 (all-zero series): height stays 0, no NaN.
        const h = max > 0 ? (p.value / max) * (CHART_H - 1) : 0;
        const x = i * slot;
        const y = CHART_H - h;
        return (
          <rect
            key={p.bucket}
            className={
              "oc-kpi__bar" + (isError && p.value > 0 ? " oc-kpi__bar--error" : "")
            }
            x={x}
            y={y}
            width={barWidth}
            height={h}
          >
            <title>
              {bucketLabel(p.bucket)} · {formatValue(p.value)} {unit}
            </title>
          </rect>
        );
      })}
    </svg>
  );
}

// Compact numbers for the big card value (1.2k etc.); plain integers stay plain.
function formatValue(v: number): string {
  if (!Number.isFinite(v)) return "0";
  if (Math.abs(v) >= 1000) {
    return (v / 1000).toFixed(v % 1000 === 0 ? 0 : 1) + "k";
  }
  return String(v);
}

// "2026-06-02T14" -> "02/06 14h" (UTC). The bucket keys are UTC hour strings, so
// we append a full time + Z to make a valid ISO instant and read it back with
// UTC getters (L6) — local getters would shift the label (e.g. ...T14 -> 16h in
// UTC+2) and could even show the wrong calendar day for a late-night bucket.
function bucketLabel(bucket: string): string {
  const d = new Date(`${bucket}:00:00Z`);
  if (Number.isNaN(d.getTime())) return bucket;
  const day = String(d.getUTCDate()).padStart(2, "0");
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const hour = String(d.getUTCHours()).padStart(2, "0");
  return `${day}/${month} ${hour}h`;
}
