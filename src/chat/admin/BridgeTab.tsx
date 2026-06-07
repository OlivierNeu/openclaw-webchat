import { useQuery } from "convex/react";
import { useNavigate } from "@tanstack/react-router";
import { CheckCircle2, AlertTriangle, WifiOff, RefreshCw } from "lucide-react";
import { api } from "../convexApi";
import { Badge } from "@/components/ui/badge";
import { dispatchErrorInfo } from "@/lib/dispatchErrorInfo";

// "Bridge" settings tab — the place to see EVERYTHING about the bridge's health:
// reachability, per-connection state, the curated root cause + fix hint of any
// failure, counters and timestamps. Reads the active health poll
// (bridgeHealth.getBridgeHealth, admin). Non-secret only — tokens/device
// identity never leave the bridge env.

type Health = NonNullable<ReturnType<typeof useBridgeHealth>>;
function useBridgeHealth() {
  return useQuery(api.bridgeHealth.getBridgeHealth, {});
}

export function BridgeTab() {
  const health = useBridgeHealth();
  const navigate = useNavigate();
  return (
    <div className="oc-bridge">
      <p className="oc-admin__hint">
        Santé du bridge — sondage actif toutes les minutes. Données non-secrètes
        uniquement : joignabilité, état des connexions, dernière cause d’échec.
        Les secrets (tokens, device identity) vivent dans l’environnement du
        bridge, jamais ici.
      </p>
      {health === undefined ? (
        <p className="oc-admin__hint">Chargement…</p>
      ) : health === null ? (
        <div className="oc-bridge-card oc-bridge-card--idle">
          Aucun relevé pour l’instant — le sondage tourne chaque minute. Reviens
          dans un moment.
        </div>
      ) : (
        <BridgeHealthDetail
          health={health}
          onSeeAnomalies={() =>
            void navigate({ to: "/settings/anomalies", search: { status: "open" } })
          }
        />
      )}
    </div>
  );
}

function BridgeHealthDetail({
  health,
  onSeeAnomalies,
}: {
  health: Health;
  onSeeAnomalies: () => void;
}) {
  const errorTargets = health.targets.filter((t) => t.state === "error");
  const unreachable = !health.reachable;
  const healthy = health.reachable && errorTargets.length === 0;
  const tone = healthy ? "ok" : "error";
  const checkedAt = new Date(health.checkedAt).toLocaleString("fr-FR");
  const startedAt =
    health.startedAt != null
      ? new Date(health.startedAt).toLocaleString("fr-FR")
      : null;

  return (
    <>
      <div className={`oc-bridge-card oc-bridge-card--${tone}`}>
        <div className="oc-bridge-card__icon" aria-hidden>
          {healthy ? (
            <CheckCircle2 size={22} />
          ) : unreachable ? (
            <WifiOff size={22} />
          ) : (
            <AlertTriangle size={22} />
          )}
        </div>
        <div className="oc-bridge-card__body">
          <div className="oc-bridge-card__title">
            {healthy
              ? "Bridge opérationnel"
              : unreachable
                ? "Bridge injoignable"
                : `Bridge : ${errorTargets.length} connexion(s) en erreur`}
          </div>
          <div className="oc-bridge-card__meta">
            <span>
              <RefreshCw size={12} aria-hidden /> Vérifié à {checkedAt}
            </span>
            {startedAt ? <span>· Bridge démarré le {startedAt}</span> : null}
          </div>
          {unreachable ? (
            <p className="oc-bridge-card__hint">
              {dispatchErrorInfo(
                health.lastError === "not_configured"
                  ? "NOT_CONFIGURED"
                  : "BRIDGE_UNREACHABLE",
              ).hint}
            </p>
          ) : null}
        </div>
        <button type="button" className="oc-bridgebar__drill" onClick={onSeeAnomalies}>
          ↗ Anomalies
        </button>
      </div>

      <h3 className="oc-bridge__section">Connexions ({health.targets.length})</h3>
      {health.targets.length === 0 ? (
        <p className="oc-admin__hint">
          Aucune connexion encore éprouvée. L’état d’une connexion apparaît dès
          qu’un message la sollicite (le bridge se connecte à la demande).
        </p>
      ) : (
        <div className="oc-bridge-targets">
          {health.targets.map((t) => {
            const info = t.lastErrorCode ? dispatchErrorInfo(t.lastErrorCode) : null;
            return (
              <div key={t.key} className={`oc-bridge-target oc-bridge-target--${t.state}`}>
                <div className="oc-bridge-target__head">
                  <code className="oc-traces__mono">
                    {t.canonical}/{t.agentId}
                  </code>
                  <TargetStateBadge state={t.state} />
                  <span className="oc-bridge-target__host">{t.gatewayHost}</span>
                </div>
                <div className="oc-bridge-target__stats">
                  {t.okCount} OK · {t.errorCount} échec(s) · {t.attempts} tentative(s)
                  {t.lastOkAt
                    ? ` · dernier OK ${new Date(t.lastOkAt).toLocaleTimeString("fr-FR")}`
                    : ""}
                </div>
                {info ? (
                  <div className="oc-bridge-target__error">
                    <strong>{info.label}</strong>{" "}
                    <code className="oc-traces__mono">{t.lastErrorCode}</code>
                    {t.lastErrorAt
                      ? ` · ${new Date(t.lastErrorAt).toLocaleTimeString("fr-FR")}`
                      : ""}
                    <p className="oc-bridge-card__hint">{info.hint}</p>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

function TargetStateBadge({ state }: { state: string }) {
  if (state === "connected") return <Badge variant="secondary">connectée</Badge>;
  if (state === "error") return <Badge variant="destructive">erreur</Badge>;
  return <Badge variant="outline">inactive</Badge>;
}
