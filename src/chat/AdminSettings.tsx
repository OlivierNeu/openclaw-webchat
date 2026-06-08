import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { api } from "./convexApi";
import type { Id } from "./convexApi";
import { UserAccessSheet } from "./admin/UserAccessSheet";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import { DataTableShell } from "./admin/DataTableShell";
import { EntitySheet } from "./admin/EntitySheet";
import { useToast } from "@/components/ui/toast";
import { FilterBar } from "./admin/filters/FilterBar";
import { AdvancedFilter } from "./admin/filters/AdvancedFilter";
import { useResolvedRange } from "./admin/filters/TimeRangePicker";
import type { Predicate, TimeRange } from "./admin/filters/types";
import {
  decodeRange,
  encodeRange,
  encodeAdv,
  parseAdv,
  DEFAULT_FROM,
  DEFAULT_TO,
} from "@/lib/routing/searchSchemas";

// Default relative window for the time-ranged admin tabs (audit). Wide (30d) so
// older/seeded rows surface on load — audit previously had NO time filter, so a
// narrow default would hide rows older than it within the bounded window.
// Re-resolves to NOW via useResolvedRange so the subscription stays current.
const DEFAULT_RANGE: TimeRange = { kind: "relative", from: DEFAULT_FROM, to: DEFAULT_TO };

// A "select all" sentinel for the quick <Select>s (radix Select has no empty
// value), mapped back to `undefined` (no filter) when building the query arg.
const ALL = "__all__";

// Admin-only settings surface (rendered only when me.role === "admin"; every
// underlying Convex function also enforces requireAdmin server-side, so this UI
// is a convenience, not the security boundary). The shell (header + tab nav +
// admin guard + ToastProvider) lives in the router's settings-layout route
// (src/router.tsx); each tab below is mounted by its own route. `TABS` is the
// single source of truth the router and the nav both read.

// Tab order = nav order. The router declares one STATIC route per FILTERED tab
// (its own typed search schema) and one shared `$tab` route for the paramless
// tabs (roles/integrations/instances/theme) — but the user-facing URL is always
// `/settings/<tab>`, and this tuple is what both sides validate against.
export const TABS = [
  "users",
  "instances",
  "bridge",
  "serviceAccounts",
  "roles",
  "traces",
  "kpi",
  "anomalies",
  "integrations",
  "theme",
  "uiprefs",
  "audit",
  "feedbacks",
] as const;
export type Tab = (typeof TABS)[number];

// The paramless tabs — they ride the shared `/settings/$tab` route in the router.
export const PARAMLESS_TABS = [
  "roles",
  "integrations",
  "instances",
  "bridge",
  "theme",
  "uiprefs",
  "feedbacks",
] as const;
export type ParamlessTab = (typeof PARAMLESS_TABS)[number];

// FR labels for tabs whose raw key isn't a clean capitalized word. Tabs absent
// from this map fall back to the CSS text-transform: capitalize on the raw key.
export const TAB_LABELS: Partial<Record<Tab, string>> = {
  serviceAccounts: "Comptes de service",
  roles: "Rôles",
  traces: "Traces",
  kpi: "KPI",
  anomalies: "Anomalies",
  integrations: "Intégrations",
  feedbacks: "Feedbacks",
  uiprefs: "Préférences UI",
  bridge: "Bridge",
};

// --- Per-tab RBAC ----------------------------------------------------------
// Which permission gates each Settings tab. Admins hold EVERY permission (the
// "*" wildcard expands to all), so they see every tab; a non-admin sees only the
// tabs whose permission was explicitly granted (profile.extraPermissions). This
// is UI convenience ONLY — every tab's Convex queries enforce the SAME
// permission server-side (requirePermission / requireAdmin), which is the real
// boundary. Keep this map total over TABS (Record<Tab,...> enforces that).
export const TAB_PERMISSION: Record<Tab, string> = {
  users: "admin.manage",
  instances: "admin.manage",
  bridge: "bridge.read",
  serviceAccounts: "admin.manage",
  roles: "admin.manage",
  traces: "traces.read",
  kpi: "kpi.read",
  anomalies: "anomalies.read",
  integrations: "admin.manage",
  theme: "admin.manage",
  uiprefs: "admin.manage",
  audit: "admin.manage",
  feedbacks: "admin.manage",
};

// The Settings tabs an admin may grant to a NON-admin. Mirrors the server-side
// GRANTABLE_USER_PERMISSIONS whitelist in convex/lib/rbac.ts — a consistency
// test (tabAccess.test.ts) keeps the two in lockstep so the grant editor can
// never offer a permission the server would reject.
export const GRANTABLE_TABS: readonly Tab[] = [
  "traces",
  "kpi",
  "anomalies",
  "bridge",
];

// The tabs a holder of `perms` may see, in canonical TABS (nav) order.
export function visibleTabs(perms: readonly string[]): Tab[] {
  const set = new Set(perms);
  return TABS.filter((t) => set.has(TAB_PERMISSION[t]));
}

// URL for a tab. The user-facing form is always `/settings/<tab>` (filtered and
// paramless tabs share the same surface). Used for programmatic navigation.
export function pathForTab(tab: Tab): string {
  return `/settings/${tab}`;
}

// The tab key embedded in a `/settings/<tab>` pathname, validated to the closed
// TABS set (undefined for `/settings` itself or an unknown segment).
export function tabFromPathname(pathname: string): Tab | undefined {
  const seg = pathname.split("/")[2];
  return (TABS as readonly string[]).includes(seg) ? (seg as Tab) : undefined;
}

// Per-row editor for the observability tabs an admin grants to a non-admin user.
// A dropdown of checkboxes (the GRANTABLE_TABS); toggling persists immediately
// via admin.setUserPermissions (which re-validates against the server whitelist).
// onSelect is preventDefault'd so the menu stays open while toggling several.
function SettingsAccessCell({
  granted,
  onToggle,
}: {
  granted: string[];
  onToggle: (perm: string) => void;
}) {
  const current = new Set(granted);
  const count = GRANTABLE_TABS.filter((t) =>
    current.has(TAB_PERMISSION[t]),
  ).length;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-8 w-36 justify-start font-normal"
        >
          {count === 0
            ? "Aucun onglet"
            : `${count} onglet${count > 1 ? "s" : ""}`}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-52">
        <DropdownMenuLabel>Onglets Settings autorisés</DropdownMenuLabel>
        {GRANTABLE_TABS.map((t) => {
          const perm = TAB_PERMISSION[t];
          return (
            <DropdownMenuItem
              key={t}
              className="gap-2"
              onSelect={(e) => {
                e.preventDefault();
                onToggle(perm);
              }}
            >
              <Checkbox
                checked={current.has(perm)}
                aria-hidden
                tabIndex={-1}
                className="pointer-events-none"
              />
              <span>{TAB_LABELS[t] ?? t}</span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function UsersTab() {
  const search = useSearch({ from: "/settings/users" });
  const navigate = useNavigate({ from: "/settings/users" });
  const q = search.q ?? "";
  const role = search.role ?? ALL;
  // `q` is debounced by FilterBar then committed here with replace (no history
  // spam while typing); quick selects push (Back restores the prior filter).
  const setQ = (v: string) =>
    void navigate({ search: (p) => ({ ...p, q: v || undefined }), replace: true });
  const setRoleFilter = (v: string) =>
    void navigate({ search: (p) => ({ ...p, role: v === ALL ? undefined : v }) });

  const users = useQuery(api.admin.listUsers, {
    filter: {
      q: q || undefined,
      role: role === ALL ? undefined : role,
    },
  });
  const me = useQuery(api.me.getMe);
  const setRole = useMutation(api.admin.setRole);
  const setPerms = useMutation(api.admin.setUserPermissions);
  const startImpersonation = useMutation(api.admin.startImpersonation);
  const toast = useToast();
  // The user whose Access editor (instance+agent assignment) is open. Replaces
  // the legacy free-text override/group columns (H4).
  const [accessFor, setAccessFor] = useState<{
    profileId: Id<"profiles">;
    label: string;
  } | null>(null);

  // Role options: the three built-ins plus any custom role already present on a
  // user row (forward-compatible if a deployment adds more).
  const roleOptions = useMemo(() => {
    const set = new Set<string>(["pending", "user", "admin"]);
    for (const u of users ?? []) set.add(u.role);
    return [...set];
  }, [users]);

  const active = q !== "" || role !== ALL;
  function reset() {
    void navigate({ search: {}, replace: true });
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

  async function changePerms(args: Parameters<typeof setPerms>[0]) {
    try {
      await setPerms(args);
    } catch (err) {
      // Server rejects any non-grantable permission (whitelist) — surface it.
      toast.error("Mise à jour des permissions refusée", err);
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
          header: "Accès Settings",
          cell: (u) =>
            u.role === "admin" ? (
              <span className="text-muted-foreground text-xs">Tous (admin)</span>
            ) : (
              <SettingsAccessCell
                granted={u.extraPermissions ?? []}
                onToggle={(perm) => {
                  const cur = new Set(u.extraPermissions ?? []);
                  if (cur.has(perm)) cur.delete(perm);
                  else cur.add(perm);
                  void changePerms({ profileId: u._id, permissions: [...cur] });
                }}
              />
            ),
        },
        {
          // Agents are assignable to EVERY user, admins included: an admin is
          // also a chat user and needs >=1 agent to start a conversation (there
          // is NO server-side "admin uses all agents" bypass — Codex P2).
          header: "Agents",
          cell: (u) => (
            <Button
              variant="outline"
              size="sm"
              className="h-8 font-normal"
              onClick={() =>
                setAccessFor({
                  profileId: u._id,
                  label:
                    u.email || u.name || u.canonical || u.userId.slice(0, 8),
                })
              }
            >
              Gérer les agents
            </Button>
          ),
        },
      ]}
    />
    <UserAccessSheet
      profileId={accessFor?.profileId ?? null}
      userLabel={accessFor?.label ?? ""}
      open={accessFor !== null}
      onOpenChange={(o) => {
        if (!o) setAccessFor(null);
      }}
    />
    </>
  );
}


type InstanceKind = "openclaw" | "hermes";
type InstanceForm = {
  name: string;
  gatewayUrl: string;
  displayName: string;
  kind: InstanceKind;
};
const EMPTY_INSTANCE: InstanceForm = {
  name: "",
  gatewayUrl: "",
  displayName: "",
  kind: "openclaw",
};

export function InstancesTab() {
  const instances = useQuery(api.admin.listInstances, {});
  const upsert = useMutation(api.admin.upsertInstance);
  const del = useMutation(api.admin.deleteInstance);
  const toast = useToast();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [form, setForm] = useState<InstanceForm>(EMPTY_INSTANCE);
  // The instance whose discovered-agents dialog is open.
  const [agentsFor, setAgentsFor] = useState<string | null>(null);

  async function submit() {
    try {
      await upsert({
        name: form.name,
        gatewayUrl: form.gatewayUrl,
        displayName: form.displayName || undefined,
        kind: form.kind,
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
        Métadonnées non-secrètes uniquement. Les agents sont <strong>découverts
        par le bridge</strong> (jamais saisis à la main) ; les tokens gateway et
        device identities vivent dans l’environnement du bridge, jamais ici.
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
          {
            header: "Bridge",
            cell: (i) => (
              <Badge variant="outline">{i.kind ?? "openclaw"}</Badge>
            ),
          },
          { header: "Gateway URL", cell: (i) => i.gatewayUrl },
          { header: "Display", cell: (i) => i.displayName ?? "—" },
          {
            header: "Agents",
            cell: (i) => (
              <Button
                variant="outline"
                size="sm"
                className="h-8 font-normal"
                onClick={() => setAgentsFor(i.name)}
              >
                Voir les agents
              </Button>
            ),
          },
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
          <Field label="Technologie (bridge)">
            <Select
              value={form.kind}
              onValueChange={(v) =>
                setForm({ ...form, kind: v as InstanceKind })
              }
            >
              <SelectTrigger size="sm" className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="openclaw">OpenClaw</SelectItem>
                <SelectItem value="hermes">Hermes</SelectItem>
              </SelectContent>
            </Select>
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
      <InstanceAgentsDialog
        instanceName={agentsFor}
        open={agentsFor !== null}
        onOpenChange={(o) => {
          if (!o) setAgentsFor(null);
        }}
      />
    </>
  );
}

// Read-only view of the agents DISCOVERED on an instance (the bridge is the
// source of truth) + the poll outcome. Manual entry is intentionally absent —
// agents come from `agents.list`, never from a text field (the prod-bug fix).
function InstanceAgentsDialog({
  instanceName,
  open,
  onOpenChange,
}: {
  instanceName: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const data = useQuery(
    api.agents.listAgentsForInstance,
    open && instanceName ? { instanceName } : "skip",
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Agents découverts — {instanceName}</DialogTitle>
          <DialogDescription>
            Liste fournie par le bridge (OpenClaw <code>agents.list</code> /
            Hermes). Lecture seule.
          </DialogDescription>
        </DialogHeader>
        {data === undefined ? (
          <p className="oc-access__hint">Chargement…</p>
        ) : (
          <>
            <div className="oc-access__poll">
              {data.discovery === null
                ? "Jamais sondé."
                : data.discovery.lastPollOk
                  ? "Découverte OK."
                  : `Hors-ligne (${data.discovery.error ?? "?"}) — dernier bon résultat servi.`}
            </div>
            {data.agents.length === 0 ? (
              <p className="oc-access__hint">Aucun agent découvert.</p>
            ) : (
              <div className="oc-access__list">
                {data.agents.map((a) => (
                  <div key={a.agentId} className="oc-access__row">
                    <span className="oc-access__label">
                      {a.emoji ? `${a.emoji} ` : ""}
                      {a.displayName ?? a.agentId}
                    </span>
                    {a.model ? (
                      <span className="oc-access__model">{a.model}</span>
                    ) : null}
                    {a.isDefaultOnInstance ? (
                      <Badge variant="outline">défaut</Badge>
                    ) : null}
                    {a.presentInLastOk === false ? (
                      <Badge variant="outline" className="oc-access__gone">
                        supprimé
                      </Badge>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
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

export function AuditTab() {
  const search = useSearch({ from: "/settings/audit" });
  const navigate = useNavigate({ from: "/settings/audit" });

  const q = search.q ?? "";
  const action = search.action ?? ALL;
  const impersonated = search.impersonated ?? ALL; // "yes" | "no" | ALL
  const resource = search.resource ?? ALL;
  // URL stores time-range TOKENS; resolve to live epoch ms at component level.
  const range = decodeRange(search.from, search.to);
  const advanced = useMemo(() => parseAdv(search.adv), [search.adv]);
  const { from, to } = useResolvedRange(range);

  const setQ = (v: string) =>
    void navigate({ search: (p) => ({ ...p, q: v || undefined }), replace: true });
  const setAction = (v: string) =>
    void navigate({ search: (p) => ({ ...p, action: v === ALL ? undefined : v }) });
  const setImpersonated = (v: string) =>
    void navigate({
      search: (p) => ({ ...p, impersonated: v === ALL ? undefined : (v as "yes" | "no") }),
    });
  const setResource = (v: string) =>
    void navigate({ search: (p) => ({ ...p, resource: v === ALL ? undefined : v }) });
  const setRange = (r: TimeRange) =>
    void navigate({ search: (p) => ({ ...p, ...encodeRange(r) }) });
  // AdvancedFilter emits on EVERY keystroke → replace (no per-keystroke history
  // / subscription spam). It does not emit on mount, so a loaded URL `adv` is
  // not clobbered.
  const setAdvanced = (preds: Predicate[]) =>
    void navigate({ search: (p) => ({ ...p, adv: encodeAdv(preds) }), replace: true });

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
    void navigate({ search: {}, replace: true });
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
      <AdvancedFilter
        fields={AUDIT_ADV_FIELDS}
        seed={advanced}
        onChange={setAdvanced}
      />
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
