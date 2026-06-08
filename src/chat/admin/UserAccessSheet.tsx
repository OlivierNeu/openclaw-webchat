import { useQuery, useMutation } from "convex/react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Star, Server } from "lucide-react";
import { useToast } from "@/components/ui/toast";
import { api } from "../convexApi";
import type { Id } from "../convexApi";

// Per-user Access editor: assign DISCOVERED agents (per instance) + set the
// single default. Replaces the legacy free-text override/group columns (H4).
// Toggles apply immediately via the userAgents mutations (server re-validates).
export function UserAccessSheet({
  profileId,
  userLabel,
  open,
  onOpenChange,
}: {
  profileId: Id<"profiles"> | null;
  userLabel: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const instances = useQuery(api.admin.listInstances, open ? {} : "skip");
  const userAgents = useQuery(
    api.agents.listUserAgents,
    open && profileId ? { profileId } : "skip",
  );

  const assigned = new Set(
    (userAgents ?? []).map((u) => `${u.instanceName}/${u.agentId}`),
  );
  const defaultKey =
    (userAgents ?? []).find((u) => u.isDefault) ?? null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="oc-access">
        <DialogHeader>
          <DialogTitle>Agents de {userLabel}</DialogTitle>
          <DialogDescription>
            Associez les agents découverts (par instance) et désignez l’agent par
            défaut. Au moins un agent est requis pour créer des conversations.
          </DialogDescription>
        </DialogHeader>

        <div className="oc-access__list">
          {instances === undefined ? (
            <p className="oc-access__hint">Chargement…</p>
          ) : instances.length === 0 ? (
            <p className="oc-access__hint">
              Aucune instance configurée. Ajoutez-en une dans l’onglet Instances.
            </p>
          ) : (
            instances.map((inst) => (
              <InstanceAgents
                key={inst._id}
                profileId={profileId}
                instanceName={inst.name}
                kind={inst.kind ?? "openclaw"}
                assigned={assigned}
                defaultKey={
                  defaultKey
                    ? `${defaultKey.instanceName}/${defaultKey.agentId}`
                    : null
                }
              />
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function InstanceAgents({
  profileId,
  instanceName,
  kind,
  assigned,
  defaultKey,
}: {
  profileId: Id<"profiles"> | null;
  instanceName: string;
  kind: "openclaw" | "hermes";
  assigned: Set<string>;
  defaultKey: string | null;
}) {
  const data = useQuery(api.agents.listAgentsForInstance, { instanceName });
  const assign = useMutation(api.agents.assignAgent);
  const remove = useMutation(api.agents.removeAgent);
  const setDefault = useMutation(api.agents.setDefaultAgent);
  const toast = useToast();

  if (!profileId) return null;
  const agents = (data?.agents ?? []).filter((a) => a.source === "discovered");
  const stale = data?.discovery && !data.discovery.lastPollOk;

  async function toggle(agentId: string, isAssigned: boolean) {
    try {
      if (isAssigned) {
        await remove({ profileId: profileId!, instanceName, agentId });
      } else {
        await assign({ profileId: profileId!, instanceName, agentId });
      }
    } catch (err) {
      toast.error("Mise à jour de l’accès refusée", err);
    }
  }
  async function makeDefault(agentId: string) {
    try {
      await setDefault({ profileId: profileId!, instanceName, agentId });
    } catch (err) {
      toast.error("Définition de l’agent par défaut refusée", err);
    }
  }

  return (
    <div className="oc-access__group">
      <div className="oc-access__instance">
        <Server size={13} aria-hidden />
        <span>{instanceName}</span>
        <Badge variant="outline" className="oc-access__kind">
          {kind}
        </Badge>
        {stale ? (
          <Badge variant="outline" className="oc-access__stale">
            hors-ligne
          </Badge>
        ) : null}
      </div>
      {data === undefined ? (
        <p className="oc-access__hint">Chargement des agents…</p>
      ) : agents.length === 0 ? (
        <p className="oc-access__hint">
          Aucun agent découvert{stale ? " (instance hors-ligne)" : ""}.
        </p>
      ) : (
        agents.map((a) => {
          const key = `${instanceName}/${a.agentId}`;
          const isAssigned = assigned.has(key);
          const isDefault = defaultKey === key;
          const gone = a.presentInLastOk === false;
          return (
            <div key={a.agentId} className="oc-access__row">
              <Checkbox
                checked={isAssigned}
                disabled={gone && !isAssigned}
                onCheckedChange={() => void toggle(a.agentId, isAssigned)}
                aria-label={`Assigner ${a.displayName ?? a.agentId}`}
              />
              <span className="oc-access__label">
                {a.emoji ? `${a.emoji} ` : ""}
                {a.displayName ?? a.agentId}
              </span>
              {a.model ? (
                <span className="oc-access__model">{a.model}</span>
              ) : null}
              {gone ? (
                <Badge variant="outline" className="oc-access__gone">
                  supprimé
                </Badge>
              ) : null}
              {isAssigned ? (
                isDefault ? (
                  // The default agent is the ONLY one that shows a (filled,
                  // gold) star — it reads as "this is the favorite". Decorative
                  // marker, sized to the icon-sm box so its glyph aligns with
                  // the hover star of the other rows.
                  <span
                    className="oc-access__fav"
                    role="img"
                    aria-label="Agent par défaut"
                    title="Agent par défaut"
                  >
                    <Star size={14} fill="currentColor" />
                  </span>
                ) : (
                  // Non-default agents have no star at rest; it is revealed on
                  // row hover / keyboard focus so it can be made the default.
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    className="oc-access__setdefault"
                    aria-label="Définir comme agent par défaut"
                    title="Définir comme agent par défaut"
                    onClick={() => void makeDefault(a.agentId)}
                  >
                    <Star size={14} />
                  </Button>
                )
              ) : null}
            </div>
          );
        })
      )}
    </div>
  );
}
