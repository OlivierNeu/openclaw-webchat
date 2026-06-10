import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";
import { api } from "../convexApi";
import {
  PARAMLESS_TABS,
  TABS,
  TAB_LABELS,
  visibleTabs,
  type ParamlessTab,
  type Tab,
} from "../AdminSettings";
import { BridgeStatusBadge } from "./BridgeStatusBadge";
import { m } from "@/paraglide/messages.js";

// i18n overrides for tab nav labels, applied as they get internationalized
// (the rest still fall back to the FR TAB_LABELS until the full migration).
const TAB_I18N: Partial<Record<Tab, () => string>> = {
  users: () => m.settings_tab_users(),
  groups: () => m.settings_tab_groups(),
  instances: () => m.settings_tab_instances(),
  bridge: () => m.settings_tab_bridge(),
  serviceAccounts: () => m.settings_tab_serviceaccounts(),
  roles: () => m.settings_tab_roles(),
  traces: () => m.settings_tab_traces(),
  kpi: () => m.settings_tab_kpi(),
  anomalies: () => m.settings_tab_anomalies(),
  files: () => m.files_tab_label(),
  preferences: () => m.settings_tab_preferences(),
  access: () => m.settings_tab_access(),
  integrations: () => m.settings_tab_integrations(),
  theme: () => m.appearance_tab_label(),
  uiprefs: () => m.uiprefs_tab_label(),
  audit: () => m.settings_tab_audit(),
  feedbacks: () => m.settings_tab_feedbacks(),
};

// Vertical, DRAG-AND-DROP settings navigation (replaces the chat list in
// Settings). Tab order is a per-user preference persisted to Convex
// (me.setSettingsTabOrder); a grip handle reorders, the link itself still
// navigates. The brand + a back link return to chat.

const TAB_CLASS = (t: Tab) =>
  "oc-admin__tab" + (TAB_LABELS[t] ? " oc-admin__tab--labeled" : "");
const TAB_ACTIVE_CLASS = (t: Tab) => TAB_CLASS(t) + " is-active";

type FilteredTabPath =
  | "/settings/users"
  | "/settings/serviceAccounts"
  | "/settings/traces"
  | "/settings/kpi"
  | "/settings/anomalies"
  | "/settings/audit";

// Merge a saved order with the code TABS: keep saved (valid, de-duped) keys
// first, then append any tab not in the saved list (newly added tabs). Unknown/
// stale saved keys are dropped. Pure → safe to memoize + unit-test.
export function mergeOrder(saved: string[] | null | undefined): Tab[] {
  const valid = new Set<string>(TABS);
  const seen = new Set<string>();
  const out: Tab[] = [];
  for (const k of saved ?? []) {
    if (valid.has(k) && !seen.has(k)) {
      out.push(k as Tab);
      seen.add(k);
    }
  }
  for (const t of TABS) if (!seen.has(t)) out.push(t);
  return out;
}

function TabLinkInner({ tab }: { tab: Tab }) {
  const label = TAB_I18N[tab]?.() ?? TAB_LABELS[tab] ?? tab;
  const activeProps = { className: TAB_ACTIVE_CLASS(tab) };
  // Path-only highlight (search params must not break the active state).
  const activeOptions = { includeSearch: false };
  const content = (
    <>
      <span className="oc-settings-nav__label">{label}</span>
      {tab === "bridge" ? <BridgeStatusBadge /> : null}
    </>
  );
  if (PARAMLESS_TABS.includes(tab as ParamlessTab)) {
    return (
      <Link
        to="/settings/$tab"
        params={{ tab: tab as ParamlessTab }}
        className={TAB_CLASS(tab)}
        activeProps={activeProps}
        activeOptions={activeOptions}
      >
        {content}
      </Link>
    );
  }
  return (
    <Link
      to={`/settings/${tab}` as FilteredTabPath}
      className={TAB_CLASS(tab)}
      activeProps={activeProps}
      activeOptions={activeOptions}
    >
      {content}
    </Link>
  );
}

function SortableTab({ tab }: { tab: Tab }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: tab });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };
  return (
    <div ref={setNodeRef} style={style} className="oc-settings-nav__item">
      <button
        type="button"
        className="oc-settings-nav__grip"
        aria-label={m.settingsnav_reorder()}
        {...attributes}
        {...listeners}
      >
        <GripVertical size={14} aria-hidden />
      </button>
      <TabLinkInner tab={tab} />
    </div>
  );
}

export function SettingsNav() {
  const me = useQuery(api.me.getMe);
  const saveOrder = useMutation(api.me.setSettingsTabOrder);
  const serverOrder = useMemo(
    () => mergeOrder(me?.settingsTabOrder ?? null),
    [me?.settingsTabOrder],
  );
  // Optimistic local order: apply a drag instantly, then persist; re-sync if the
  // server value changes (e.g. another device).
  const [order, setOrder] = useState<Tab[]>(serverOrder);
  useEffect(() => setOrder(serverOrder), [serverOrder]);

  // Per-tab RBAC: only render the tabs this user may open (admins see all). The
  // drag list (DnD + persistence) operates on this VISIBLE subset, so a
  // non-admin never reorders into a tab they can't see.
  const visibleSet = useMemo(
    () => new Set(visibleTabs(me?.permissions ?? [])),
    [me?.permissions],
  );
  const visibleOrder = useMemo(
    () => order.filter((t) => visibleSet.has(t)),
    [order, visibleSet],
  );

  // Pointer (distance constraint so a grip click doesn't start a spurious drag)
  // + KEYBOARD: the grip announces space/arrow reordering, so it must actually
  // work for keyboard users (a11y) — and it makes reordering deterministically
  // testable.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const from = visibleOrder.indexOf(active.id as Tab);
    const to = visibleOrder.indexOf(over.id as Tab);
    if (from < 0 || to < 0) return;
    const nextVisible = arrayMove(visibleOrder, from, to);
    // Persist the full per-user order: reordered visible tabs first, then the
    // hidden (not-permitted) tabs in their existing relative order. For an admin
    // (all tabs visible) this is simply the full reorder.
    const hidden = order.filter((t) => !visibleSet.has(t));
    const next = [...nextVisible, ...hidden];
    setOrder(next); // optimistic
    void saveOrder({ order: next });
  }

  return (
    <nav className="oc-settings-nav" aria-label={m.settingsnav_aria()}>
      <Link to="/" className="oc-settings-nav__back">
        {m.settingsnav_back()}
      </Link>
      <div className="oc-settings-nav__title">{m.settingsnav_title()}</div>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[restrictToVerticalAxis]}
        onDragEnd={onDragEnd}
      >
        <SortableContext
          items={visibleOrder}
          strategy={verticalListSortingStrategy}
        >
          <div className="oc-settings-nav__list">
            {visibleOrder.map((t) => (
              <SortableTab key={t} tab={t} />
            ))}
          </div>
        </SortableContext>
      </DndContext>
    </nav>
  );
}
