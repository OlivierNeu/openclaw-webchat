import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../convexApi";
import type { Id } from "../convexApi";
import { DataTableShell } from "./DataTableShell";
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

const STATUS_FILTERS = [
  { value: "open", label: "Ouvertes" },
  { value: "all", label: "Toutes" },
] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number]["value"];

const LIST_LIMIT = 200;

export function AnomaliesTab() {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("open");
  const confirm = useConfirm();
  const toast = useToast();
  const resolveAnomaly = useMutation(api.anomalies.resolveAnomaly);

  const rows = useQuery(api.anomalies.listAnomalies, {
    status: statusFilter === "open" ? "open" : undefined,
    limit: LIST_LIMIT,
  }) as AnomalyView[] | undefined;

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
        acquitter une anomalie ouverte la sort du décompte de heartbeat.
      </p>

      <div className="oc-traces__toolbar">
        <div className="oc-traces__filters">
          <Select
            value={statusFilter}
            onValueChange={(v) => setStatusFilter(v as StatusFilter)}
          >
            <SelectTrigger size="sm" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_FILTERS.map((s) => (
                <SelectItem key={s.value} value={s.value}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <DataTableShell
        title="Anomalies"
        rows={rows}
        emptyHint={
          statusFilter === "open"
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
