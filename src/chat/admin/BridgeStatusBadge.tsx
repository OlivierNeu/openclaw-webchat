import { useQuery } from "convex/react";
import { api } from "../convexApi";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

// Live health dot on the "Bridge" settings tab: green when up, red when down,
// grey before the first poll. Hover shows a one-line summary; the full detail
// lives in the tab itself (BridgeTab). Reads the light, non-admin availability
// projection (getBridgeAvailability) so it never throws on the tab strip.

export function BridgeStatusBadge() {
  const a = useQuery(api.bridgeHealth.getBridgeAvailability, {});
  if (a === undefined) return null; // loading — no dot yet

  const tone = !a.known ? "idle" : a.available ? "ok" : "error";
  const summary = !a.known
    ? "Bridge : pas encore de relevé (sondage chaque minute)"
    : a.available
      ? `Bridge opérationnel${
          a.checkedAt
            ? ` · vérifié à ${new Date(a.checkedAt).toLocaleTimeString("fr-FR")}`
            : ""
        }`
      : `Bridge indisponible (${a.reason ?? "?"}) — ouvre l’onglet Bridge pour le détail`;

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={`oc-bridge-dot oc-bridge-dot--${tone}`}
            role="img"
            aria-label={summary}
          />
        </TooltipTrigger>
        <TooltipContent>{summary}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
