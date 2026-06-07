// Admin-facing presentation of a dispatch root-cause CODE.
//
// The backend ships only a stable, non-PHI CODE on a failed-dispatch trace /
// anomaly (see convex/bridge.ts + bridge/src/core/dispatch-errors.ts). This map
// turns that code into something an admin can ACT on: a short French label and a
// concrete fix hint — the difference between "a dispatch failed" and "fix
// OPENCLAW_AGENT_ID". Unknown/new codes degrade gracefully to the raw code.
//
// Pure data + a pure lookup → unit-testable, no React.

export interface DispatchErrorInfo {
  /** Short French label for the cause. */
  label: string;
  /** Concrete, actionable fix hint for an operator. */
  hint: string;
}

const INFO: Record<string, DispatchErrorInfo> = {
  AGENT_NOT_FOUND: {
    label: "Agent introuvable",
    hint: "L’agent configuré n’existe plus sur la passerelle. Vérifiez OPENCLAW_AGENT_ID dans le .env du bridge (il doit correspondre à un agent réel de la passerelle).",
  },
  AUTH_TOKEN_MISMATCH: {
    label: "Authentification refusée",
    hint: "Le token opérateur ne correspond pas au device pairé. Re-pairez un device dédié au bridge sur la passerelle et reportez son token + device identity.",
  },
  DEVICE_SIGNING_FAILED: {
    label: "Signature device impossible",
    hint: "La clé privée du device identity ne se décode pas. Vérifiez OPENCLAW_DEVICE_IDENTITY (format JSON, \\n simples) — voir fix-devid.mjs.",
  },
  SESSION_SCOPE_DENIED: {
    label: "Portée insuffisante",
    hint: "Le pairing du device n’a pas la portée requise (operator.admin). Approuvez/élevez la portée du device sur la passerelle.",
  },
  GATEWAY_TIMEOUT: {
    label: "Délai dépassé",
    hint: "La passerelle n’a pas répondu à temps. Vérifiez qu’elle est démarrée et joignable (OPENCLAW_GATEWAY_URL).",
  },
  GATEWAY_DISCONNECTED: {
    label: "Passerelle déconnectée",
    hint: "La connexion à la passerelle a été coupée. Vérifiez l’état du conteneur OpenClaw et l’URL/port de la passerelle.",
  },
  BRIDGE_UNREACHABLE: {
    label: "Bridge injoignable",
    hint: "Convex n’a pas pu joindre le bridge. Vérifiez que le conteneur bridge tourne et BRIDGE_URL (http://<ip-hôte>:8787).",
  },
  INVALID_REQUEST: {
    label: "Requête invalide",
    hint: "La passerelle a rejeté la requête. Consultez les logs du bridge pour le détail brut.",
  },
  NOT_CONFIGURED: {
    label: "Bridge non configuré",
    hint: "BRIDGE_URL / BRIDGE_SHARED_SECRET ne sont pas définis côté Convex (npx convex env set).",
  },
  UNROUTED: {
    label: "Utilisateur non routé",
    hint: "Ce compte n’est rattaché à aucune instance. Settings → Users → Override instance, ou affectez un groupe.",
  },
  UPSTREAM_ERROR: {
    label: "Erreur passerelle",
    hint: "Cause non catégorisée. Consultez les logs du bridge pour le message brut.",
  },
  UNKNOWN: {
    label: "Cause inconnue",
    hint: "Aucun code de cause n’a été remonté (bridge antérieur à cette version ?). Consultez les logs du bridge.",
  },
};

/** Look up the admin info for a dispatch error code; falls back to the raw code. */
export function dispatchErrorInfo(code: string | undefined | null): DispatchErrorInfo {
  if (!code) return INFO.UNKNOWN!;
  return INFO[code] ?? { label: code, hint: "Cause non répertoriée — voir les logs du bridge." };
}
