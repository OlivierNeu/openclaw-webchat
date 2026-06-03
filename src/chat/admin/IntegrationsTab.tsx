import { useQuery } from "convex/react";
import { api } from "../convexApi";
import { DataTableShell } from "./DataTableShell";
import { Badge } from "@/components/ui/badge";

// "Integrations" tab (D-3) — outbound trace-shipping vendor status. Reads
// api.integrations.status (admin). SECRET-SAFE by construction: it only shows the
// per-vendor `configured` boolean (derived from env presence server-side) and the
// public shipping cursors (watermark + secret-free failure bookkeeping). It NEVER
// renders keys/hosts — those live in deployment env and never cross the boundary.

type IntegrationsStatus = {
  langfuse: { configured: boolean };
  opik: { configured: boolean };
  cursors: Array<{
    vendor: string;
    lastAt: number;
    failureCount: number;
    lastError: string | null;
    lastErrorStatus: number | null;
  }>;
};

type CursorRow = IntegrationsStatus["cursors"][number] & { _id: string };

export function IntegrationsTab() {
  // Module path is `integrations/status`, export `status` → api.integrations.status.status.
  const status = useQuery(api.integrations.status.status, {}) as
    | IntegrationsStatus
    | undefined;

  // DataTableShell keys on `_id`; the cursor rows have no document id, so key
  // them by vendor (unique per row).
  const cursorRows: CursorRow[] | undefined = status?.cursors.map((c) => ({
    ...c,
    _id: c.vendor,
  }));

  return (
    <>
      <p className="oc-admin__hint">
        État des intégrations d’export de traces (Langfuse, Opik). Affiche
        uniquement si le vendeur est <strong>configuré</strong> (présence des
        variables d’environnement côté déploiement) et les curseurs d’expédition.
        Aucun secret (clé, hôte) n’est jamais exposé ici.
      </p>

      <section className="oc-int__vendors">
        <VendorCard name="Langfuse" configured={status?.langfuse.configured} />
        <VendorCard name="Opik" configured={status?.opik.configured} />
      </section>

      <DataTableShell
        title="Curseurs d’expédition"
        rows={cursorRows}
        emptyHint="Aucun curseur — aucune trace n’a encore été expédiée."
        columns={[
          {
            header: "Vendeur",
            cell: (c) => <Badge variant="secondary">{c.vendor}</Badge>,
          },
          {
            header: "Dernier envoi",
            cell: (c) => (
              <span className="oc-traces__time">
                {c.lastAt > 0
                  ? new Date(c.lastAt).toLocaleString("fr-FR")
                  : "—"}
              </span>
            ),
          },
          {
            header: "Échecs consécutifs",
            cell: (c) =>
              c.failureCount > 0 ? (
                <span className="oc-anomaly__sev oc-anomaly__sev--warn">
                  {c.failureCount}
                </span>
              ) : (
                <span className="oc-traces__muted">0</span>
              ),
          },
          {
            header: "Dernier statut HTTP",
            cell: (c) =>
              c.lastErrorStatus !== null ? (
                <span className="oc-traces__mono">{c.lastErrorStatus}</span>
              ) : (
                <span className="oc-traces__muted">—</span>
              ),
          },
          {
            header: "Dernière erreur",
            cell: (c) =>
              c.lastError ? (
                <span className="oc-anomaly__msg">{c.lastError}</span>
              ) : (
                <span className="oc-traces__muted">—</span>
              ),
          },
        ]}
      />
    </>
  );
}

function VendorCard({
  name,
  configured,
}: {
  name: string;
  configured: boolean | undefined;
}) {
  return (
    <div className="oc-int__vendor">
      <span className="oc-int__vendor-name">{name}</span>
      {configured === undefined ? (
        <Badge variant="outline">…</Badge>
      ) : configured ? (
        <Badge variant="secondary">configuré</Badge>
      ) : (
        <Badge variant="outline">non configuré</Badge>
      )}
    </div>
  );
}
