import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Wrench } from "lucide-react";
import { api } from "./convexApi";

type Role = "pending" | "user" | "admin";
const ROLES: Role[] = ["admin", "user", "pending"];

// DEV-ONLY user switcher. Visible ONLY when the deployment has the dev Anonymous
// provider on (`authProviders.anonymous`) — never in production. Removes the
// CLI-and-ids friction of multi-user testing: list every account + role, a
// one-click "become admin" escape hatch (so you're never stuck on a non-admin /
// pending session), per-user role control, and "act as" (reuses the audited
// admin impersonation). Nothing here exists in prod (the queries are dev-gated
// server-side AND this component renders null when anon is off).
export function DevUserSwitcher() {
  const providers = useQuery(api.me.authProviders);
  const isDev = providers?.anonymous === true;
  const [open, setOpen] = useState(false);

  const users = useQuery(api.dev.listUsersDev, isDev ? {} : "skip");
  const imp = useQuery(api.me.getImpersonation) as
    | { impersonating: false }
    | { impersonating: true; targetLabel: string; realLabel: string }
    | undefined;
  const setMyRole = useMutation(api.dev.setMyRole);
  const setRole = useMutation(api.dev.setRole);
  const startImp = useMutation(api.admin.startImpersonation);
  const stopImp = useMutation(api.admin.stopImpersonation);

  if (!isDev) return null;

  const me = users?.find((u) => u.isMe);
  const amAdmin = me?.role === "admin";
  const impersonating = imp?.impersonating === true;
  const others = (users ?? []).filter((u) => !u.isMe);

  return (
    <>
      <button
        type="button"
        className="oc-devfab"
        onClick={() => setOpen(true)}
        title="Mode dev — comptes & rôles"
      >
        <Wrench size={13} />
        DEV
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Mode dev — comptes & rôles</DialogTitle>
            <DialogDescription>
              Change de rôle et « agis en tant que » pour tester plusieurs
              utilisateurs sans CLI. Visible uniquement en dev.
            </DialogDescription>
          </DialogHeader>

          {/* Current session — role self-service (escape hatch). */}
          <div className="oc-devsw__me">
            <span className="oc-devsw__melabel">
              Moi — {me?.canonical ?? "…"}{" "}
              <Badge variant="outline">{me?.role ?? "…"}</Badge>
            </span>
            <div className="oc-devsw__roles">
              {ROLES.map((r) => (
                <Button
                  key={r}
                  type="button"
                  size="xs"
                  variant={me?.role === r ? "secondary" : "ghost"}
                  disabled={me?.role === r}
                  onClick={() => void setMyRole({ role: r })}
                >
                  {r === "admin"
                    ? "Devenir admin"
                    : r === "user"
                      ? "Devenir user"
                      : "Devenir pending"}
                </Button>
              ))}
            </div>
          </div>

          {impersonating ? (
            <div className="oc-devsw__imp">
              Tu agis en tant que <strong>{imp.targetLabel}</strong>.
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={() => void stopImp()}
              >
                Arrêter
              </Button>
            </div>
          ) : null}

          {/* Other accounts. */}
          <div className="oc-devsw__list">
            {others.length === 0 ? (
              <p className="oc-devsw__empty">
                Aucun autre compte. Déconnecte-toi puis reconnecte-toi (nouvelle
                identité anonyme) — elle sera active immédiatement.
              </p>
            ) : (
              others.map((u) => (
                <div key={u.profileId} className="oc-devsw__row">
                  <span className="oc-devsw__label">
                    {u.name || u.email || u.canonical || u.userId.slice(0, 8)}
                  </span>
                  <select
                    className="oc-devsw__select"
                    value={u.role}
                    disabled={!u.canonical}
                    onChange={(e) =>
                      u.canonical &&
                      void setRole({
                        canonical: u.canonical,
                        role: e.target.value as Role,
                      })
                    }
                  >
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    disabled={!amAdmin || u.role === "pending"}
                    title={
                      !amAdmin
                        ? "Deviens admin d'abord"
                        : u.role === "pending"
                          ? "Un compte pending ne peut pas être impersonné"
                          : "Agir en tant que cet utilisateur"
                    }
                    onClick={() => {
                      void startImp({ profileId: u.profileId });
                      setOpen(false);
                    }}
                  >
                    Agir en tant que
                  </Button>
                </div>
              ))
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
