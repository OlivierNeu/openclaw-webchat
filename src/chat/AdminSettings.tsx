import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "./convexApi";
import { ThemeShowroom } from "./ThemeShowroom";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DataTableShell } from "./admin/DataTableShell";
import { EntitySheet } from "./admin/EntitySheet";

// Admin-only settings surface (rendered only when me.role === "admin"; every
// underlying Convex function also enforces requireAdmin server-side, so this UI
// is a convenience, not the security boundary). Tabs: Users (roles + approval +
// per-user routing), Groups (valves), Instances (non-secret meta), Theme
// (component showroom for the active design tokens).

const TABS = ["users", "groups", "instances", "theme", "audit"] as const;
type Tab = (typeof TABS)[number];

export function AdminSettings() {
  const [tab, setTab] = useState<Tab>("users");
  return (
    <div className="oc-admin">
      <header className="oc-admin__header">
        <h1>Settings</h1>
        <nav className="oc-admin__tabs">
          {TABS.map((t) => (
            <button
              key={t}
              className={"oc-admin__tab" + (tab === t ? " is-active" : "")}
              onClick={() => setTab(t)}
            >
              {t}
            </button>
          ))}
        </nav>
      </header>
      <div className="oc-admin__body">
        {tab === "users" ? <UsersTab /> : null}
        {tab === "groups" ? <GroupsTab /> : null}
        {tab === "instances" ? <InstancesTab /> : null}
        {tab === "theme" ? <ThemeShowroom /> : null}
        {tab === "audit" ? <AuditTab /> : null}
      </div>
    </div>
  );
}

function UsersTab() {
  const users = useQuery(api.admin.listUsers, {});
  const groups = useQuery(api.admin.listGroups, {});
  const me = useQuery(api.me.getMe);
  const setRole = useMutation(api.admin.setRole);
  const setRouting = useMutation(api.admin.setUserRouting);
  const startImpersonation = useMutation(api.admin.startImpersonation);

  return (
    <DataTableShell
      title="Users"
      rows={users}
      emptyHint="Aucun utilisateur."
      rowActions={(u) =>
        // No self-impersonation (the server also rejects it); hide the action
        // on the admin's own row.
        u.userId === me?.userId
          ? []
          : [
              {
                label: "Voir comme cet utilisateur",
                onSelect: () =>
                  void startImpersonation({ profileId: u._id }),
              },
            ]
      }
      columns={[
        {
          header: "User",
          cell: (u) =>
            u.email || u.name || u.canonical || u.userId.slice(0, 8),
        },
        {
          header: "Role",
          cell: (u) => (
            <Select
              value={u.role}
              onValueChange={(v) =>
                void setRole({
                  profileId: u._id,
                  role: v as "pending" | "user" | "admin",
                })
              }
            >
              <SelectTrigger size="sm" className="w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="pending">pending</SelectItem>
                <SelectItem value="user">user</SelectItem>
                <SelectItem value="admin">admin</SelectItem>
              </SelectContent>
            </Select>
          ),
        },
        {
          header: "Group",
          cell: (u) => (
            <Select
              value={u.groupId ?? "none"}
              onValueChange={(v) =>
                void setRouting({
                  profileId: u._id,
                  groupId: v === "none" ? null : (v as never),
                })
              }
            >
              <SelectTrigger size="sm" className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">— none —</SelectItem>
                {(groups ?? []).map((g) => (
                  <SelectItem key={g._id} value={g._id}>
                    {g.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ),
        },
        {
          header: "Override instance",
          cell: (u) => (
            <Input
              className="h-8 w-44"
              defaultValue={u.overrideInstance ?? ""}
              placeholder="(group)"
              onBlur={(e) =>
                void setRouting({
                  profileId: u._id,
                  overrideInstance: e.target.value || null,
                })
              }
            />
          ),
        },
        {
          header: "Override agent",
          cell: (u) => (
            <Input
              className="h-8 w-44"
              defaultValue={u.overrideAgentId ?? ""}
              placeholder="(derived)"
              onBlur={(e) =>
                void setRouting({
                  profileId: u._id,
                  overrideAgentId: e.target.value || null,
                })
              }
            />
          ),
        },
      ]}
    />
  );
}

type GroupForm = {
  name: string;
  instanceName: string;
  mode: "per-user" | "shared";
  sharedAgentId: string;
};
const EMPTY_GROUP: GroupForm = {
  name: "",
  instanceName: "",
  mode: "per-user",
  sharedAgentId: "",
};

function GroupsTab() {
  const groups = useQuery(api.admin.listGroups, {});
  const createGroup = useMutation(api.admin.createGroup);
  const deleteGroup = useMutation(api.admin.deleteGroup);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [form, setForm] = useState<GroupForm>(EMPTY_GROUP);

  async function submit() {
    await createGroup({
      name: form.name,
      instanceName: form.instanceName,
      mode: form.mode,
      sharedAgentId: form.mode === "shared" ? form.sharedAgentId : undefined,
    });
    setForm(EMPTY_GROUP);
    setSheetOpen(false);
  }

  return (
    <>
      <DataTableShell
        title="Groups"
        rows={groups}
        addLabel="Add group"
        onAdd={() => {
          setForm(EMPTY_GROUP);
          setSheetOpen(true);
        }}
        emptyHint="Aucun groupe."
        columns={[
          { header: "Name", cell: (g) => g.name },
          { header: "Instance", cell: (g) => g.instanceName },
          { header: "Mode", cell: (g) => g.mode },
          { header: "Shared agent", cell: (g) => g.sharedAgentId ?? "—" },
        ]}
        rowActions={(g) => [
          {
            label: "Delete",
            variant: "destructive",
            onSelect: () => void deleteGroup({ groupId: g._id }),
          },
        ]}
        bulkActions={[
          {
            label: "Delete",
            variant: "destructive",
            onSelect: (ids) =>
              ids.forEach((id) =>
                void deleteGroup({ groupId: id as never }),
              ),
          },
        ]}
      />
      <EntitySheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        title="Nouveau groupe"
        description="Routage par groupe (valve)."
        canSubmit={Boolean(form.name && form.instanceName) &&
          (form.mode !== "shared" || Boolean(form.sharedAgentId))}
        onSubmit={submit}
        submitLabel="Ajouter"
      >
        <div className="oc-form">
          <Field label="Nom du groupe">
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </Field>
          <Field label="Instance">
            <Input
              value={form.instanceName}
              onChange={(e) =>
                setForm({ ...form, instanceName: e.target.value })
              }
            />
          </Field>
          <Field label="Mode">
            <Select
              value={form.mode}
              onValueChange={(v) =>
                setForm({ ...form, mode: v as "per-user" | "shared" })
              }
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="per-user">
                  per-user (chacun son agent)
                </SelectItem>
                <SelectItem value="shared">shared (agent commun)</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          {form.mode === "shared" ? (
            <Field label="Shared agentId">
              <Input
                value={form.sharedAgentId}
                onChange={(e) =>
                  setForm({ ...form, sharedAgentId: e.target.value })
                }
              />
            </Field>
          ) : null}
        </div>
      </EntitySheet>
    </>
  );
}

type InstanceForm = { name: string; gatewayUrl: string; displayName: string };
const EMPTY_INSTANCE: InstanceForm = { name: "", gatewayUrl: "", displayName: "" };

function InstancesTab() {
  const instances = useQuery(api.admin.listInstances, {});
  const upsert = useMutation(api.admin.upsertInstance);
  const del = useMutation(api.admin.deleteInstance);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [form, setForm] = useState<InstanceForm>(EMPTY_INSTANCE);

  async function submit() {
    await upsert({
      name: form.name,
      gatewayUrl: form.gatewayUrl,
      displayName: form.displayName || undefined,
    });
    setForm(EMPTY_INSTANCE);
    setSheetOpen(false);
  }

  return (
    <>
      <p className="oc-admin__hint">
        Métadonnées non-secrètes uniquement. Les tokens gateway et device
        identities vivent dans l’environnement du bridge, jamais ici.
      </p>
      <DataTableShell
        title="Instances"
        rows={instances}
        addLabel="Add instance"
        onAdd={() => {
          setForm(EMPTY_INSTANCE);
          setSheetOpen(true);
        }}
        emptyHint="Aucune instance."
        columns={[
          { header: "Name", cell: (i) => i.name },
          { header: "Gateway URL", cell: (i) => i.gatewayUrl },
          { header: "Display", cell: (i) => i.displayName ?? "—" },
        ]}
        rowActions={(i) => [
          {
            label: "Delete",
            variant: "destructive",
            onSelect: () => void del({ instanceId: i._id }),
          },
        ]}
        bulkActions={[
          {
            label: "Delete",
            variant: "destructive",
            onSelect: (ids) =>
              ids.forEach((id) => void del({ instanceId: id as never })),
          },
        ]}
      />
      <EntitySheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        title="Nouvelle instance"
        description="Métadonnées non-secrètes."
        canSubmit={Boolean(form.name && form.gatewayUrl)}
        onSubmit={submit}
        submitLabel="Enregistrer"
      >
        <div className="oc-form">
          <Field label="Nom de l’instance (ex. olivier)">
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </Field>
          <Field label="Gateway URL (ws(s)://)">
            <Input
              value={form.gatewayUrl}
              onChange={(e) => setForm({ ...form, gatewayUrl: e.target.value })}
            />
          </Field>
          <Field label="Nom affiché (optionnel)">
            <Input
              value={form.displayName}
              onChange={(e) => setForm({ ...form, displayName: e.target.value })}
            />
          </Field>
        </div>
      </EntitySheet>
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="oc-field">
      <span className="oc-field__label">{label}</span>
      {children}
    </label>
  );
}

// Audit trail of impersonated actions: WHO really acted and AS WHOM. Read-only.
// Message content is never recorded server-side (PHI), so only the action verb
// and the touched resource kind/id are shown.
function AuditTab() {
  const rows = useQuery(api.admin.listAudit, {});
  return (
    <>
      <p className="oc-admin__hint">
        Trace des actions effectuées sous usurpation d’identité : qui a
        réellement agi (acteur réel) et au nom de quel utilisateur. Le contenu
        des messages n’est jamais enregistré.
      </p>
      <DataTableShell
        title="Audit"
        rows={rows}
        emptyHint="Aucune action tracée pour l’instant."
        columns={[
          {
            header: "Quand",
            cell: (r) => new Date(r.at).toLocaleString("fr-FR"),
          },
          { header: "Action", cell: (r) => r.action },
          { header: "Acteur réel", cell: (r) => r.realLabel },
          { header: "Au nom de", cell: (r) => r.targetLabel ?? "—" },
          {
            header: "Ressource",
            cell: (r) =>
              r.resource
                ? r.resource +
                  (r.resourceId ? ` · ${r.resourceId.slice(0, 8)}` : "")
                : "—",
          },
        ]}
      />
    </>
  );
}
