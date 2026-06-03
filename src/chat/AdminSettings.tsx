import { useMemo, useState } from "react";
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
import { ServiceAccountsTab } from "./admin/ServiceAccountsTab";
import { RolesTab } from "./admin/RolesTab";
import { TracesTab } from "./admin/TracesTab";
import { KpiTab } from "./admin/KpiTab";
import { AnomaliesTab } from "./admin/AnomaliesTab";
import { IntegrationsTab } from "./admin/IntegrationsTab";
import { ToastProvider, useToast } from "@/components/ui/toast";
import { FilterBar } from "./admin/filters/FilterBar";
import { AdvancedFilter } from "./admin/filters/AdvancedFilter";
import { useResolvedRange } from "./admin/filters/TimeRangePicker";
import type { Predicate, TimeRange } from "./admin/filters/types";

// Default relative window for the time-ranged admin tabs (audit). Wide (30d) so
// older/seeded rows surface on load — audit previously had NO time filter, so a
// narrow default would hide rows older than it within the bounded window.
// Re-resolves to NOW via useResolvedRange so the subscription stays current.
const DEFAULT_RANGE: TimeRange = { kind: "relative", from: "now-30d", to: "now" };

// A "select all" sentinel for the quick <Select>s (radix Select has no empty
// value), mapped back to `undefined` (no filter) when building the query arg.
const ALL = "__all__";

// Admin-only settings surface (rendered only when me.role === "admin"; every
// underlying Convex function also enforces requireAdmin server-side, so this UI
// is a convenience, not the security boundary). Tabs: Users (roles + approval +
// per-user routing), Groups (valves), Instances (non-secret meta), Theme
// (component showroom for the active design tokens).

const TABS = [
  "users",
  "groups",
  "instances",
  "serviceAccounts",
  "roles",
  "traces",
  "kpi",
  "anomalies",
  "integrations",
  "theme",
  "audit",
] as const;
type Tab = (typeof TABS)[number];

// FR labels for tabs whose raw key isn't a clean capitalized word. Tabs absent
// from this map fall back to the CSS text-transform: capitalize on the raw key.
const TAB_LABELS: Partial<Record<Tab, string>> = {
  serviceAccounts: "Comptes de service",
  roles: "Rôles",
  traces: "Traces",
  kpi: "KPI",
  anomalies: "Anomalies",
  integrations: "Intégrations",
};

export function AdminSettings() {
  const [tab, setTab] = useState<Tab>("users");
  return (
    // ToastProvider mounted here (not at App root, which is out of this pass's
    // edit scope): every error-surfacing call site is a child of AdminSettings,
    // so one provider here covers all admin-tab mutations.
    <ToastProvider>
    <div className="oc-admin">
      <header className="oc-admin__header">
        <h1>Settings</h1>
        <nav className="oc-admin__tabs">
          {TABS.map((t) => (
            <button
              key={t}
              className={
                "oc-admin__tab" +
                (tab === t ? " is-active" : "") +
                (TAB_LABELS[t] ? " oc-admin__tab--labeled" : "")
              }
              onClick={() => setTab(t)}
            >
              {TAB_LABELS[t] ?? t}
            </button>
          ))}
        </nav>
      </header>
      <div className="oc-admin__body">
        {tab === "users" ? <UsersTab /> : null}
        {tab === "groups" ? <GroupsTab /> : null}
        {tab === "instances" ? <InstancesTab /> : null}
        {tab === "serviceAccounts" ? <ServiceAccountsTab /> : null}
        {tab === "roles" ? <RolesTab /> : null}
        {tab === "traces" ? <TracesTab /> : null}
        {tab === "kpi" ? <KpiTab /> : null}
        {tab === "anomalies" ? <AnomaliesTab /> : null}
        {tab === "integrations" ? <IntegrationsTab /> : null}
        {tab === "theme" ? <ThemeShowroom /> : null}
        {tab === "audit" ? <AuditTab /> : null}
      </div>
    </div>
    </ToastProvider>
  );
}

function UsersTab() {
  const [q, setQ] = useState("");
  const [role, setRoleFilter] = useState<string>(ALL);

  const users = useQuery(api.admin.listUsers, {
    filter: {
      q: q || undefined,
      role: role === ALL ? undefined : role,
    },
  });
  // Groups are unfiltered here (they feed the per-row routing <Select>).
  const groups = useQuery(api.admin.listGroups, {});
  const me = useQuery(api.me.getMe);
  const setRole = useMutation(api.admin.setRole);
  const setRouting = useMutation(api.admin.setUserRouting);
  const startImpersonation = useMutation(api.admin.startImpersonation);
  const toast = useToast();

  // Role options: the three built-ins plus any custom role already present on a
  // user row (forward-compatible if a deployment adds more).
  const roleOptions = useMemo(() => {
    const set = new Set<string>(["pending", "user", "admin"]);
    for (const u of users ?? []) set.add(u.role);
    return [...set];
  }, [users]);

  const active = q !== "" || role !== ALL;
  function reset() {
    setQ("");
    setRoleFilter(ALL);
  }

  // M5: setRole can be REFUSED server-side (e.g. "cannot demote the last
  // admin"). Without surfacing, the controlled <Select> just snaps back on the
  // next reactive tick with no explanation. Wrap it and toast the server error.
  async function changeRole(args: Parameters<typeof setRole>[0]) {
    try {
      await setRole(args);
    } catch (err) {
      toast.error("Changement de rôle refusé", err);
    }
  }

  async function changeRouting(args: Parameters<typeof setRouting>[0]) {
    try {
      await setRouting(args);
    } catch (err) {
      toast.error("Mise à jour du routage refusée", err);
    }
  }

  return (
    <>
    <FilterBar
      q={q}
      onQChange={setQ}
      searchPlaceholder="Rechercher (email, nom)"
      onReset={reset}
      canReset={active}
    >
      <Select value={role} onValueChange={setRoleFilter}>
        <SelectTrigger size="sm" className="w-36">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>Tous les rôles</SelectItem>
          {roleOptions.map((r) => (
            <SelectItem key={r} value={r}>
              {r}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </FilterBar>
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
                void changeRole({
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
                void changeRouting({
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
                void changeRouting({
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
                void changeRouting({
                  profileId: u._id,
                  overrideAgentId: e.target.value || null,
                })
              }
            />
          ),
        },
      ]}
    />
    </>
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
  const [q, setQ] = useState("");
  const [mode, setMode] = useState<string>(ALL);
  const groups = useQuery(api.admin.listGroups, {
    filter: {
      q: q || undefined,
      mode: mode === ALL ? undefined : mode,
    },
  });
  const createGroup = useMutation(api.admin.createGroup);
  const deleteGroup = useMutation(api.admin.deleteGroup);
  const toast = useToast();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [form, setForm] = useState<GroupForm>(EMPTY_GROUP);

  const active = q !== "" || mode !== ALL;
  function reset() {
    setQ("");
    setMode(ALL);
  }

  async function submit() {
    try {
      await createGroup({
        name: form.name,
        instanceName: form.instanceName,
        mode: form.mode,
        sharedAgentId: form.mode === "shared" ? form.sharedAgentId : undefined,
      });
      setForm(EMPTY_GROUP);
      setSheetOpen(false);
    } catch (err) {
      // M5: surface duplicate-key / validation rejections instead of swallowing.
      toast.error("Échec de la création du groupe", err);
    }
  }

  return (
    <>
      <FilterBar
        q={q}
        onQChange={setQ}
        searchPlaceholder="Rechercher (nom, instance)"
        onReset={reset}
        canReset={active}
      >
        <Select value={mode} onValueChange={setMode}>
          <SelectTrigger size="sm" className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Tous les modes</SelectItem>
            <SelectItem value="per-user">per-user</SelectItem>
            <SelectItem value="shared">shared</SelectItem>
          </SelectContent>
        </Select>
      </FilterBar>
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
  const toast = useToast();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [form, setForm] = useState<InstanceForm>(EMPTY_INSTANCE);

  async function submit() {
    try {
      await upsert({
        name: form.name,
        gatewayUrl: form.gatewayUrl,
        displayName: form.displayName || undefined,
      });
      setForm(EMPTY_INSTANCE);
      setSheetOpen(false);
    } catch (err) {
      // M5: surface server-side rejection instead of swallowing.
      toast.error("Échec de l’enregistrement de l’instance", err);
    }
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
// Field list for the audit advanced builder (view fields the backend exposes).
const AUDIT_ADV_FIELDS = [
  { value: "action", label: "action" },
  { value: "realLabel", label: "acteur réel" },
  { value: "targetLabel", label: "au nom de" },
  { value: "impersonated", label: "usurpation" },
  { value: "resource", label: "ressource" },
  { value: "resourceId", label: "id ressource" },
];

function AuditTab() {
  const [q, setQ] = useState("");
  const [action, setAction] = useState<string>(ALL);
  const [impersonated, setImpersonated] = useState<string>(ALL);
  const [resource, setResource] = useState<string>(ALL);
  const [range, setRange] = useState<TimeRange>(DEFAULT_RANGE);
  const [advanced, setAdvanced] = useState<Predicate[]>([]);
  const { from, to } = useResolvedRange(range);

  const rows = useQuery(api.admin.listAudit, {
    filter: {
      q: q || undefined,
      from,
      to,
      action: action === ALL ? undefined : action,
      resource: resource === ALL ? undefined : resource,
      impersonated: impersonated === ALL ? undefined : impersonated === "yes",
      advanced: advanced.length > 0 ? advanced : undefined,
    },
  });

  // Dynamic option lists derived from the loaded window.
  const actionOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows ?? []) set.add(r.action);
    return [...set].sort();
  }, [rows]);
  const resourceOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows ?? []) if (r.resource) set.add(r.resource);
    return [...set].sort();
  }, [rows]);

  const active =
    q !== "" ||
    action !== ALL ||
    impersonated !== ALL ||
    resource !== ALL ||
    advanced.length > 0 ||
    range.kind !== "relative" ||
    range.from !== DEFAULT_RANGE.from;
  function reset() {
    setQ("");
    setAction(ALL);
    setImpersonated(ALL);
    setResource(ALL);
    setRange(DEFAULT_RANGE);
    setAdvanced([]);
  }

  return (
    <>
      <p className="oc-admin__hint">
        Trace des actions effectuées sous usurpation d’identité : qui a
        réellement agi (acteur réel) et au nom de quel utilisateur. Le contenu
        des messages n’est jamais enregistré.{" "}
        <span className="oc-filter__window">
          Fenêtre récente bornée — une plage antérieure peut être partielle.
        </span>
      </p>
      <FilterBar
        q={q}
        onQChange={setQ}
        searchPlaceholder="Rechercher (action, acteur, ressource)"
        timeRange={range}
        onTimeRangeChange={setRange}
        onReset={reset}
        canReset={active}
      >
        <Select value={action} onValueChange={setAction}>
          <SelectTrigger size="sm" className="w-40">
            <SelectValue placeholder="Action" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Toutes les actions</SelectItem>
            {actionOptions.map((a) => (
              <SelectItem key={a} value={a}>
                {a}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={impersonated} onValueChange={setImpersonated}>
          <SelectTrigger size="sm" className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Usurpation : toutes</SelectItem>
            <SelectItem value="yes">Sous usurpation</SelectItem>
            <SelectItem value="no">Sans usurpation</SelectItem>
          </SelectContent>
        </Select>
        <Select value={resource} onValueChange={setResource}>
          <SelectTrigger size="sm" className="w-40">
            <SelectValue placeholder="Ressource" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Toutes les ressources</SelectItem>
            {resourceOptions.map((r) => (
              <SelectItem key={r} value={r}>
                {r}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FilterBar>
      <AdvancedFilter fields={AUDIT_ADV_FIELDS} onChange={setAdvanced} />
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
