import { useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { X } from "lucide-react";
import { api } from "../convexApi";
import type { Id } from "../convexApi";
import { DataTableShell } from "./DataTableShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// "Traces" tab — recent observability events (D2: redacted metadata only, no
// message content). Reads api.observability.listEvents, an admin query that
// returns a BOUNDED recent window (newest first). All filtering described below
// that is NOT a backend arg happens client-side over that fetched window.
//
// Two-query structure (the non-obvious bit):
//  - `unfiltered` (no kind) feeds BOTH the kind <Select> option list AND the
//    "follow a turn" correlationId filter. Deriving the option list from the
//    UNfiltered window means picking a kind never collapses the dropdown, and a
//    correlationId turn spanning multiple kinds is shown whole.
//  - `filtered` (kind passed to the backend, which over-fetches + post-filters)
//    is what the table renders in the normal case. Server-side `kind` is kept
//    because it surfaces rare kinds the bounded `unfiltered` window might miss.
//  When kind === "all" both queries have identical args, so Convex dedupes the
//  subscription (no extra cost in the common case).

type TraceEventView = {
  _id: Id<"traceEvents">;
  at: number;
  kind: string;
  direction: "inbound" | "outbound" | "internal" | null;
  principalType: "user" | "service" | "system";
  principalId: string | null;
  roleKey: string | null;
  route: string | null;
  method: string | null;
  status: number | null;
  latencyMs: number | null;
  chatId: string | null;
  runId: string | null;
  correlationId: string | null;
  redacted: boolean;
  meta: string | null;
};

// Backend caps at MAX_LIST_LIMIT (500); offer a few sensible window sizes.
const LIMIT_OPTIONS = [50, 100, 200, 500] as const;
type LimitValue = (typeof LIMIT_OPTIONS)[number];

const ALL_KINDS = "all";

export function TracesTab() {
  const [limit, setLimit] = useState<LimitValue>(100);
  const [kind, setKind] = useState<string>(ALL_KINDS);
  // Active "follow a turn" filter (client-side, over the unfiltered window).
  const [followCorr, setFollowCorr] = useState<string | null>(null);
  // The row whose `meta` JSON is open in the shared Dialog.
  const [metaRow, setMetaRow] = useState<TraceEventView | null>(null);

  // Option list + correlation base: never kind-filtered (see header note).
  const unfiltered = useQuery(api.observability.listEvents, { limit }) as
    | TraceEventView[]
    | undefined;
  // Table source in the normal case. Map the synthetic "all" to undefined so we
  // never ask the backend to filter for a literal "all" kind (→ empty result).
  const filtered = useQuery(api.observability.listEvents, {
    limit,
    kind: kind === ALL_KINDS ? undefined : kind,
  }) as TraceEventView[] | undefined;

  // Distinct kinds present in the unfiltered window (stable; does not collapse
  // when a kind is selected). Sorted for a predictable dropdown order.
  const kindOptions = useMemo(() => {
    const set = new Set<string>();
    for (const e of unfiltered ?? []) set.add(e.kind);
    return [...set].sort();
  }, [unfiltered]);

  // Following a correlationId wins over the kind filter: it reads from the
  // unfiltered window so the WHOLE turn (across kinds) is shown. Otherwise the
  // kind-filtered window is the table source.
  const rows: TraceEventView[] | undefined = followCorr
    ? unfiltered?.filter((e) => e.correlationId === followCorr)
    : filtered;

  return (
    <>
      <p className="oc-admin__hint">
        Événements récents (fenêtre bornée, plus récents d’abord). Toutes les
        traces sont des métadonnées <strong>expurgées</strong> : aucun contenu
        de message, pièce jointe ou jeton n’est stocké — uniquement des
        longueurs, codes et indicateurs.
      </p>

      <div className="oc-traces__toolbar">
        <div className="oc-traces__filters">
          {followCorr ? (
            <button
              type="button"
              className="oc-traces__chip"
              onClick={() => setFollowCorr(null)}
              title="Effacer le filtre de corrélation"
            >
              <span className="oc-traces__chip-label">
                filtre: correlationId=
                <code>{shortId(followCorr)}</code>
              </span>
              <X className="oc-traces__chip-x" aria-hidden />
              <span className="sr-only">Effacer</span>
            </button>
          ) : null}
          <Select value={kind} onValueChange={setKind}>
            <SelectTrigger size="sm" className="w-44">
              <SelectValue placeholder="Tous les kinds" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_KINDS}>tous les kinds</SelectItem>
              {kindOptions.map((k) => (
                <SelectItem key={k} value={k}>
                  {k}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={String(limit)}
            onValueChange={(v) => setLimit(Number(v) as LimitValue)}
          >
            <SelectTrigger size="sm" className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LIMIT_OPTIONS.map((n) => (
                <SelectItem key={n} value={String(n)}>
                  {n} lignes
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <DataTableShell
        title="Traces"
        rows={rows}
        emptyHint={
          followCorr
            ? "Aucun événement pour cette corrélation dans la fenêtre."
            : "Aucun événement tracé pour l’instant."
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
            header: "Kind",
            cell: (r) => <Badge variant="secondary">{r.kind}</Badge>,
          },
          {
            header: "Direction",
            cell: (r) =>
              r.direction ? (
                <Badge variant="outline">{r.direction}</Badge>
              ) : (
                <span className="oc-traces__muted">—</span>
              ),
          },
          {
            header: "Principal",
            cell: (r) => (
              <span className="oc-traces__principal">
                <Badge variant="outline">{r.principalType}</Badge>
                {r.principalId ? (
                  <code className="oc-traces__mono">
                    {shortId(r.principalId)}
                  </code>
                ) : null}
              </span>
            ),
          },
          {
            header: "Rôle",
            cell: (r) =>
              r.roleKey ? (
                <Badge variant="secondary">{r.roleKey}</Badge>
              ) : (
                <span className="oc-traces__muted">—</span>
              ),
          },
          {
            header: "Route",
            cell: (r) =>
              r.route ? (
                <span className="oc-traces__route">
                  {r.method ? (
                    <span className="oc-traces__method">{r.method}</span>
                  ) : null}
                  <code className="oc-traces__mono">{r.route}</code>
                </span>
              ) : (
                <span className="oc-traces__muted">—</span>
              ),
          },
          {
            header: "Statut",
            cell: (r) =>
              r.status === null ? (
                <span className="oc-traces__muted">—</span>
              ) : (
                <span
                  className={`oc-traces__status ${statusClass(r.status)}`}
                >
                  {r.status}
                </span>
              ),
          },
          {
            header: "Latence",
            cell: (r) =>
              r.latencyMs === null ? (
                <span className="oc-traces__muted">—</span>
              ) : (
                <span className="oc-traces__mono">{r.latencyMs} ms</span>
              ),
          },
          {
            header: "Corrélation",
            cell: (r) =>
              r.correlationId ? (
                <button
                  type="button"
                  className="oc-traces__corr"
                  title="Suivre ce tour (filtrer par correlationId)"
                  onClick={() => setFollowCorr(r.correlationId)}
                >
                  {shortId(r.correlationId)}
                </button>
              ) : (
                <span className="oc-traces__muted">—</span>
              ),
          },
          {
            header: "Meta",
            cell: (r) =>
              r.meta ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setMetaRow(r)}
                >
                  Voir
                </Button>
              ) : (
                <span className="oc-traces__muted">—</span>
              ),
          },
        ]}
      />

      <MetaDialog row={metaRow} onClose={() => setMetaRow(null)} />
    </>
  );
}

// Color the status by HTTP class. Hex literals live in convexChat.css (the one
// constraint-allowed exception); here we only pick the class.
function statusClass(status: number): string {
  if (status >= 500) return "oc-traces__status--5xx";
  if (status >= 400) return "oc-traces__status--4xx";
  if (status >= 200 && status < 300) return "oc-traces__status--2xx";
  return "oc-traces__status--other";
}

// First 8 chars is enough to recognize an id/correlationId at a glance.
function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

// Shared meta viewer: pretty-prints the row's JSON `meta` (falling back to the
// raw string if it isn't valid JSON). Reassures that traces are redacted
// metadata — no message content is ever stored.
function MetaDialog({
  row,
  onClose,
}: {
  row: TraceEventView | null;
  onClose: () => void;
}) {
  const pretty = useMemo(() => {
    if (!row?.meta) return "";
    try {
      return JSON.stringify(JSON.parse(row.meta), null, 2);
    } catch {
      // Not valid JSON — show the raw stored string rather than nothing.
      return row.meta;
    }
  }, [row]);

  return (
    <Dialog
      open={row !== null}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      {row ? (
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="oc-traces__meta-title">
              Meta · <code>{row.kind}</code>
              <Badge variant="outline">expurgé</Badge>
            </DialogTitle>
            <DialogDescription>
              Métadonnées non-PHI uniquement (longueurs, codes, indicateurs).
              Aucun contenu de message n’est stocké.
            </DialogDescription>
          </DialogHeader>
          <pre className="oc-traces__meta-json">{pretty}</pre>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
