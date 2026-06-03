import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../convexApi";
import type { Id } from "../convexApi";
import { DataTableShell } from "./DataTableShell";
import { FilterBar } from "./filters/FilterBar";
import { useResolvedRange } from "./filters/TimeRangePicker";
import type { TimeRange } from "./filters/types";
import { useConfirm } from "@/components/ConfirmDialog";
import { useToast } from "@/components/ui/toast";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// "Anomalies" tab (D-3) — detector + agent-reported anomalies. Reads
// api.anomalies.listAnomalies (admin) and offers a per-open-row Resolve /
// Acknowledge action via api.anomalies.resolveAnomaly. All rows are non-PHI
// metadata (kind, severity, message, correlationId); evidence is a JSON string
// the reporter is responsible for keeping PHI-free.
//
// Status filter is a CLIENT control that maps to the backend `status` arg:
// "open" → only open rows; "all" → no status filter (the backend returns
// newest-first across all statuses). Resolve actions are only offered on open
// rows (resolving an already-resolved row is a no-op).

type AnomalyView = {
  _id: Id<"anomalies">;
  at: number;
  kind: string;
  severity: "info" | "warn" | "critical";
  status: "open" | "acknowledged" | "resolved";
  message: string;
  source: "detector" | "agent";
  correlationId: string | null;
  evidence: string | null;
  resolvedAt: number | null;
  resolvedBy: string | null;
};

// "Select all" sentinel for the quick <Select>s (radix has no empty value).
const ALL = "__all__";

// anomalyStatus options (the backend filter key is `anomalyStatus`, NOT the
// top-level `status` arg). Default "open" preserves today's view.
const STATUS_OPTIONS = [
  { value: "open", label: "Ouvertes" },
  { value: "acknowledged", label: "Acquittées" },
  { value: "resolved", label: "Résolues" },
] as const;

const SEVERITIES = ["info", "warn", "critical"] as const;
const SOURCES = ["detector", "agent"] as const;

// Default time window for the anomalies table. Wide (30d) so seeded/older
// anomalies surface on load — anomalies previously had NO time filter, so a
// narrow default would hide rows older than it within the bounded window.
const DEFAULT_RANGE: TimeRange = { kind: "relative", from: "now-30d", to: "now" };

const LIST_LIMIT = 200;

export function AnomaliesTab() {
  const [q, setQ] = useState("");
  // Default to "open" (mirrors the previous default view).
  const [anomalyStatus, setAnomalyStatus] = useState<string>("open");
  const [severity, setSeverity] = useState<string>(ALL);
  const [source, setSource] = useState<string>(ALL);
  const [kind, setKind] = useState<string>(ALL);
  const [range, setRange] = useState<TimeRange>(DEFAULT_RANGE);
  const { from, to } = useResolvedRange(range);

  const confirm = useConfirm();
  const toast = useToast();
  const resolveAnomaly = useMutation(api.anomalies.resolveAnomaly);

  const rows = useQuery(api.anomalies.listAnomalies, {
    limit: LIST_LIMIT,
    filter: {
      q: q || undefined,
      from,
      to,
      // The backend status filter key for anomalies is `anomalyStatus`.
      anomalyStatus: anomalyStatus === ALL ? undefined : anomalyStatus,
      severity: severity === ALL ? undefined : severity,
      source: source === ALL ? undefined : source,
      kind: kind === ALL ? undefined : kind,
    },
  }) as AnomalyView[] | undefined;

  // Distinct kinds present in the current window (dynamic option list).
  const kindOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows ?? []) set.add(r.kind);
    return [...set].sort();
  }, [rows]);

  const filtersActive =
    q !== "" ||
    anomalyStatus !== "open" ||
    severity !== ALL ||
    source !== ALL ||
    kind !== ALL ||
    range.kind !== "relative" ||
    range.from !== DEFAULT_RANGE.from;
  function resetFilters() {
    setQ("");
    setAnomalyStatus("open");
    setSeverity(ALL);
    setSource(ALL);
    setKind(ALL);
    setRange(DEFAULT_RANGE);
  }

  async function resolve(row: AnomalyView) {
    const ok = await confirm({
      title: "Résoudre cette anomalie ?",
      description: (
        <>
          L’anomalie <span className="font-mono">{row.kind}</span> sera marquée
          comme <strong>résolue</strong>. Elle sortira du décompte des anomalies
          ouvertes (signal de self-repair OpenClaw).
        </>
      ),
      confirmLabel: "Résoudre",
    });
    if (!ok) return;
    try {
      await resolveAnomaly({ anomalyId: row._id, status: "resolved" });
      toast.success("Anomalie résolue", row.kind);
    } catch (err) {
      toast.error("Échec de la résolution", err);
    }
  }

  async function acknowledge(row: AnomalyView) {
    try {
      await resolveAnomaly({ anomalyId: row._id, status: "acknowledged" });
      toast.success("Anomalie acquittée", row.kind);
    } catch (err) {
      toast.error("Échec de l’acquittement", err);
    }
  }

  return (
    <>
      <p className="oc-admin__hint">
        Anomalies détectées (cron) ou signalées par les agents OpenClaw. Données
        non-PHI uniquement (type, sévérité, message, corrélation). Résoudre ou
        acquitter une anomalie ouverte la sort du décompte de heartbeat.{" "}
        <span className="oc-filter__window">
          La plage temporelle filtre la fenêtre récente — une plage antérieure
          peut être partielle.
        </span>
      </p>

      <FilterBar
        q={q}
        onQChange={setQ}
        searchPlaceholder="Rechercher (message, type, corrélation)"
        timeRange={range}
        onTimeRangeChange={setRange}
        onReset={resetFilters}
        canReset={filtersActive}
      >
        <Select value={anomalyStatus} onValueChange={setAnomalyStatus}>
          <SelectTrigger size="sm" className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Tous les statuts</SelectItem>
            {STATUS_OPTIONS.map((s) => (
              <SelectItem key={s.value} value={s.value}>
                {s.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={severity} onValueChange={setSeverity}>
          <SelectTrigger size="sm" className="w-36">
            <SelectValue placeholder="Sévérité" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Toutes sévérités</SelectItem>
            {SEVERITIES.map((s) => (
              <SelectItem key={s} value={s}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={source} onValueChange={setSource}>
          <SelectTrigger size="sm" className="w-32">
            <SelectValue placeholder="Source" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Toutes sources</SelectItem>
            {SOURCES.map((s) => (
              <SelectItem key={s} value={s}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={kind} onValueChange={setKind}>
          <SelectTrigger size="sm" className="w-36">
            <SelectValue placeholder="Type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Tous les types</SelectItem>
            {kindOptions.map((k) => (
              <SelectItem key={k} value={k}>
                {k}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FilterBar>

      <DataTableShell
        title="Anomalies"
        rows={rows}
        emptyHint={
          anomalyStatus === "open"
            ? "Aucune anomalie ouverte. 🎉"
            : "Aucune anomalie enregistrée."
        }
        rowActions={(r) =>
          r.status === "open"
            ? [
                { label: "Résoudre", onSelect: () => void resolve(r) },
                {
                  label: "Acquitter",
                  onSelect: () => void acknowledge(r),
                },
              ]
            : []
        }
        columns={[
          {
            header: "Quand",
            cell: (r) => (
              <span className="oc-traces__time">
                {new Date(r.at).toLocaleString("fr-FR")}
              </span>
            ),
          },
          {
            header: "Type",
            cell: (r) => <code className="oc-traces__mono">{r.kind}</code>,
          },
          {
            header: "Sévérité",
            cell: (r) => <SeverityBadge severity={r.severity} />,
          },
          {
            header: "Statut",
            cell: (r) => <StatusBadge status={r.status} />,
          },
          {
            header: "Source",
            cell: (r) => <Badge variant="outline">{r.source}</Badge>,
          },
          {
            header: "Message",
            cell: (r) => <span className="oc-anomaly__msg">{r.message}</span>,
          },
          {
            header: "Corrélation",
            cell: (r) =>
              r.correlationId ? (
                <code className="oc-traces__mono">
                  {shortId(r.correlationId)}
                </code>
              ) : (
                <span className="oc-traces__muted">—</span>
              ),
          },
        ]}
      />
    </>
  );
}

function SeverityBadge({ severity }: { severity: AnomalyView["severity"] }) {
  // Color via CSS class (hex literals allowed in convexChat.css, mirroring the
  // trace status convention). Critical is the loudest; warn amber; info muted.
  return (
    <span className={`oc-anomaly__sev oc-anomaly__sev--${severity}`}>
      {severity}
    </span>
  );
}

function StatusBadge({ status }: { status: AnomalyView["status"] }) {
  if (status === "open") return <Badge variant="destructive">ouverte</Badge>;
  if (status === "acknowledged")
    return <Badge variant="secondary">acquittée</Badge>;
  return <Badge variant="outline">résolue</Badge>;
}

// First 8 chars is enough to recognize a correlationId at a glance (mirrors
// TracesTab.shortId).
function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}
