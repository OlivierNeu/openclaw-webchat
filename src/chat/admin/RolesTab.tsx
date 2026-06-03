import { useEffect, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Lock } from "lucide-react";
import { api } from "../convexApi";
import type { Id } from "../convexApi";
import { EntitySheet } from "./EntitySheet";
import { useConfirm } from "@/components/ConfirmDialog";
import { useToast } from "@/components/ui/toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";

// "Rôles" tab — permission MATRIX.
//
// Layout: rows = roles (built-in + custom), columns = permission keys grouped
// into sections. Checkboxes toggle a role's permission via
// api.apiKeys.updateRolePermissions. The `admin` built-in carries the wildcard
// "*" → rendered as "all", every cell checked + locked (never let it be
// unchecked into a lockout).
//
// D-2: we no longer maintain a client-side BUILTIN_BASELINE overlay (it could
// drift from convex/lib/rbac.ts). Instead we call api.apiKeys.ensureRolesSeeded
// once on mount so the built-in rows exist server-side, and render PURELY from
// api.apiKeys.listRoles. The brief pre-seed window (listRoles === [] before the
// seed mutation lands) shows an "initialisation" hint, then fills reactively.
//
// M4: updateRolePermissions sends the FULL permission array (the backend does a
// full patch replace, no merge). Two quick toggles on one role row could clobber
// each other (read-modify-write race). We attach a withOptimisticUpdate that
// patches the listRoles cache immediately, AND disable that role's checkboxes
// while a write for it is in flight (pending Set) so a stale read can't win.

// Frontend-decoupled copy of the closed permission set (rbac.PERMISSIONS),
// grouped + labeled for the matrix columns. Keep in sync with convex/lib/rbac.ts.
const PERMISSION_GROUPS: {
  group: string;
  keys: { key: string; label: string; phi?: boolean }[];
}[] = [
  {
    group: "Traces",
    keys: [
      { key: "traces.read", label: "Lire" },
      {
        key: "traces.read.content",
        label: "Contenu",
        phi: true,
      },
      { key: "traces.write", label: "Écrire" },
    ],
  },
  {
    group: "KPI",
    keys: [
      { key: "kpi.read", label: "Lire" },
      { key: "kpi.write", label: "Écrire" },
    ],
  },
  {
    group: "OpenClaw / Anomalies",
    keys: [
      { key: "openclaw.query", label: "Query" },
      { key: "anomalies.read", label: "Anomalies" },
      { key: "anomalies.report", label: "Signaler" },
    ],
  },
  {
    group: "Chats",
    keys: [{ key: "chats.read", label: "Lire" }],
  },
  {
    group: "Admin",
    keys: [{ key: "admin.manage", label: "Gérer" }],
  },
];

const ALL_PERMISSION_KEYS = PERMISSION_GROUPS.flatMap((g) =>
  g.keys.map((k) => k.key),
);

type StoredRole = {
  _id: Id<"roles">;
  key: string;
  name: string;
  description: string | null;
  builtin: boolean;
  permissions: string[];
};

function isWildcard(permissions: string[]): boolean {
  return permissions.includes("*");
}

type RoleForm = { key: string; name: string; description: string };
const EMPTY_ROLE: RoleForm = { key: "", name: "", description: "" };

export function RolesTab() {
  const stored = useQuery(api.apiKeys.listRoles, {}) as
    | StoredRole[]
    | undefined;
  const createRole = useMutation(api.apiKeys.createRole);
  const ensureRolesSeeded = useMutation(api.apiKeys.ensureRolesSeeded);
  // M4: optimistic update patches the listRoles cache the instant the user
  // toggles, so a second quick toggle reads the already-updated permissions
  // (not the stale server snapshot). Convex auto-rolls-back on rejection.
  const updateRolePermissions = useMutation(
    api.apiKeys.updateRolePermissions,
  ).withOptimisticUpdate((localStore, { roleId, permissions }) => {
    const current = localStore.getQuery(api.apiKeys.listRoles, {});
    if (!current) return;
    localStore.setQuery(
      api.apiKeys.listRoles,
      {},
      current.map((r) =>
        r._id === roleId ? { ...r, permissions } : r,
      ),
    );
  });
  const confirm = useConfirm();
  const toast = useToast();

  const [sheetOpen, setSheetOpen] = useState(false);
  const [form, setForm] = useState<RoleForm>(EMPTY_ROLE);
  // M4: roleIds with an in-flight permission write — their checkboxes are
  // disabled until the write settles, so two quick toggles can't clobber.
  const [pending, setPending] = useState<Set<string>>(new Set());

  // D-2: seed built-in roles once on mount (idempotent, admin-gated). listRoles
  // is read-only and cannot seed; this guarantees the matrix isn't empty on a
  // fresh deployment without a hand-maintained client baseline.
  useEffect(() => {
    void ensureRolesSeeded({}).catch((err) => {
      toast.error("Échec de l’initialisation des rôles", err);
    });
  }, [ensureRolesSeeded, toast]);

  const roles = stored ?? [];

  async function togglePermission(role: StoredRole, permKey: string) {
    // Never mutate a wildcard role (admin) into a partial set (lockout guard).
    if (isWildcard(role.permissions)) return;
    // Already writing for this role — ignore (the checkbox is also disabled).
    if (pending.has(role._id)) return;

    const has = role.permissions.includes(permKey);
    const next = has
      ? role.permissions.filter((p) => p !== permKey)
      : [...role.permissions, permKey];

    // Warn before editing a built-in role (they may be edited, with caution).
    if (role.builtin) {
      const ok = await confirm({
        title: `Modifier le rôle intégré « ${role.name} » ?`,
        description:
          "Les rôles intégrés sont la base du modèle de permissions. Les " +
          "modifier peut affecter les comptes existants. Continuer ?",
        confirmLabel: "Modifier",
      });
      if (!ok) return;
    }

    setPending((prev) => new Set(prev).add(role._id));
    try {
      await updateRolePermissions({ roleId: role._id, permissions: next });
    } catch (err) {
      // M5: surface the rejection (e.g. backend admin-wildcard guard). The
      // optimistic patch is auto-rolled-back by Convex on throw.
      toast.error("Échec de la mise à jour des permissions", err);
    } finally {
      setPending((prev) => {
        const nextSet = new Set(prev);
        nextSet.delete(role._id);
        return nextSet;
      });
    }
  }

  async function submitRole() {
    try {
      await createRole({
        key: form.key,
        name: form.name,
        description: form.description || undefined,
        permissions: [], // toggled afterwards in the matrix
      });
      setForm(EMPTY_ROLE);
      setSheetOpen(false);
    } catch (err) {
      // M5: surface duplicate-key ("Role already exists") and validation errors.
      toast.error("Échec de la création du rôle", err);
    }
  }

  // Two distinct "not ready" states:
  //  - stored === undefined: the listRoles query hasn't resolved yet (loading).
  //  - stored === []: query resolved empty — the brief pre-seed window before
  //    ensureRolesSeeded lands; it fills reactively once built-ins persist.
  const querying = stored === undefined;
  const seeding = !querying && roles.length === 0;

  return (
    <>
      <p className="oc-admin__hint">
        Matrice de permissions. Lignes = rôles (intégrés + personnalisés),
        colonnes = clés de permission. Le rôle <code>admin</code> détient le
        joker « * » (toutes les permissions) et est verrouillé. La colonne{" "}
        <code>traces.read.content</code> donne accès au contenu brut (PHI) — à
        n’accorder qu’à bon escient.
      </p>

      <div className="oc-dt__bar">
        <h2 className="oc-dt__title">Rôles</h2>
        <div className="oc-dt__bar-actions">
          <Button
            size="sm"
            onClick={() => {
              setForm(EMPTY_ROLE);
              setSheetOpen(true);
            }}
          >
            Ajouter un rôle
          </Button>
        </div>
      </div>

      {querying ? (
        <p className="oc-admin__hint">Chargement…</p>
      ) : seeding ? (
        <p className="oc-admin__hint">Initialisation des rôles…</p>
      ) : (
        <div className="oc-matrix__scroll">
          <table className="oc-matrix">
            <thead>
              <tr>
                <th className="oc-matrix__corner" rowSpan={2}>
                  Rôle
                </th>
                {PERMISSION_GROUPS.map((g) => (
                  <th
                    key={g.group}
                    className="oc-matrix__group"
                    colSpan={g.keys.length}
                  >
                    {g.group}
                  </th>
                ))}
              </tr>
              <tr>
                {PERMISSION_GROUPS.flatMap((g) =>
                  g.keys.map((k) => (
                    <th
                      key={k.key}
                      className="oc-matrix__perm"
                      title={
                        k.phi
                          ? `${k.key} — accès au contenu brut (PHI), à accorder avec prudence`
                          : k.key
                      }
                    >
                      {k.label}
                      {k.phi ? <span className="oc-matrix__phi"> ⚠</span> : null}
                    </th>
                  )),
                )}
              </tr>
            </thead>
            <tbody>
              {roles.map((role) => {
                const wildcard = isWildcard(role.permissions);
                const rowPending = pending.has(role._id);
                return (
                  <tr key={role.key}>
                    <th className="oc-matrix__rolecell">
                      <div className="oc-matrix__rolename">
                        <span>{role.name}</span>
                        {role.builtin ? (
                          <Badge variant="outline" className="gap-1">
                            <Lock /> intégré
                          </Badge>
                        ) : (
                          <Badge variant="secondary">custom</Badge>
                        )}
                      </div>
                      <code className="oc-matrix__rolekey">{role.key}</code>
                    </th>
                    {ALL_PERMISSION_KEYS.map((permKey) => {
                      const granted =
                        wildcard || role.permissions.includes(permKey);
                      // Locked when: wildcard role (admin), or a write for this
                      // role is in flight (M4 race guard).
                      const locked = wildcard || rowPending;
                      return (
                        <td key={permKey} className="oc-matrix__cell">
                          <Checkbox
                            checked={granted}
                            disabled={locked}
                            aria-label={`${role.key} · ${permKey}`}
                            title={
                              wildcard
                                ? "Accordé via « * » (toutes les permissions)"
                                : rowPending
                                  ? "Écriture en cours…"
                                  : permKey
                            }
                            onCheckedChange={() =>
                              void togglePermission(role, permKey)
                            }
                          />
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <EntitySheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        title="Nouveau rôle"
        description="Rôle personnalisé. Ajustez les permissions dans la matrice après création."
        canSubmit={Boolean(form.key && form.name)}
        onSubmit={submitRole}
        submitLabel="Créer"
      >
        <div className="oc-form">
          <label className="oc-field">
            <span className="oc-field__label">Clé (identifiant stable)</span>
            <Input
              value={form.key}
              placeholder="ex. analyst"
              onChange={(e) => setForm({ ...form, key: e.target.value })}
            />
          </label>
          <label className="oc-field">
            <span className="oc-field__label">Nom affiché</span>
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </label>
          <label className="oc-field">
            <span className="oc-field__label">Description (optionnel)</span>
            <Input
              value={form.description}
              onChange={(e) =>
                setForm({ ...form, description: e.target.value })
              }
            />
          </label>
        </div>
      </EntitySheet>
    </>
  );
}
