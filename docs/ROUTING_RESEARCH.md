# Routing research & decision — openclaw-webchat

Status: research synthesis → decision → implementation plan. Drives the routing
work (task #44). Stack as it stands today: Vite 8 + React 19 + TypeScript 6 +
Convex 1.39 + `@convex-dev/auth` 0.0.80, **pure client SPA, no router yet**.
Navigation is React `useState` inside `ConvexChatApp` (`activeChatId`,
`showSettings`) and `AdminSettings` (`tab`), plus per-tab filter `useState`. None
of it is in the URL → nothing is bookmarkable, refresh-safe, or AI-drivable.

---

## 1. RECOMMENDATION

**Adopt TanStack Router v1 (code-based `createRouter`), with `validateSearch`
schemas that reuse the existing, already-tested `src/chat/admin/filters/types.ts`
helpers.**

One-liner: *TanStack Router — compile-time-typed search params, an
auto-derived/stable URL schema, and schema-validated degradation of malformed
URLs win 3 of the 4 stated criteria (type-safety, AI-drivability, robustness);
"bookmarkable" is a tie; and the one real anti-TanStack argument (loaders can't
call `useQuery`) is moot here because every surface fetches with component-level
`useQuery` and we keep it that way.*

### Why TanStack and not React Router v7

The four research agents split 2–2 (Agents 1 & 4 → TanStack; Agents 2 & 3 →
RRv7). That split dissolves once you weigh it against the **explicitly ranked
criteria for this task**: type-safety + bookmarkable filter state +
AI-drivability + robustness.

| Criterion (task priority) | TanStack Router | React Router v7 |
|---|---|---|
| **Type-safety** | First-class: `validateSearch` makes search params a typed, inferred object; `<Link>`/`navigate` are typed against the route tree. Compile-time errors on shape drift. | `useSearchParams` returns raw `URLSearchParams`. Type-safety is bolt-on (zod) + hand-written coercion + boilerplate per tab. |
| **Bookmarkable filter state** | Native: search object validated at route entry, refresh-safe. | Works, but you own encode/decode/sync (`useEffect` + `useSearchParams`) per tab. |
| **AI-drivability** | URL schema is *derived from the route + search schema* → one stable contract an agent reads and constructs. | You hand-author and hand-maintain the schema doc; drift risk between code and contract. |
| **Robustness** | Malformed URL → `validateSearch` coerces or falls to defaults deterministically, in one place. | Malformed URL silently degrades unless every tab wraps `useSearchParams` in its own validator. |

So on the **stated** criteria it is not 2–2 — it is lopsided toward TanStack.
Three of four are TanStack's home turf; "bookmarkable" is a tie.

**The one substantive pro-RRv7 argument — and why it doesn't bite here.** Agent 3
warns that TanStack route *loaders* cannot call React hooks (`useQuery`), and
that there are no public TanStack+Convex starters. Checked against this codebase:
**we use zero loaders.** Every surface — chat (`useConvexChatRuntime`), every
admin tab (`useQuery(api.admin.*)`, `api.observability.listEvents`, `api.kpi.*`,
`api.anomalies.*`) — fetches reactively at component level, and all four agents
agree that is the correct Convex pattern (loaders break subscription
reactivity). If we never write a loader, the loader objection is moot, and the
provider composition is **identical for both routers**:

```tsx
<ConvexAuthProvider client={convex}>
  <RouterProvider router={router} />
</ConvexAuthProvider>
```

That removes the only real differentiator favoring RRv7. The remaining RRv7
edges (bigger ecosystem, more weekly downloads) don't move a 1–2 dev SPA where
the ranked goal is type-safety + a machine-readable URL contract.

**Clincher specific to THIS codebase.** `src/chat/admin/filters/types.ts` is
already a pure, framework-free, unit-tested module: the `TimeRange` discriminated
union, `Predicate`, `resolveRange`, `resolveToken`, `coercePredicateValue`. It
maps 1:1 onto a zod `validateSearch` schema. We route `validateSearch` **through
those existing helpers** rather than re-deriving coercion in zod — minimal new
code on top of an already-tested layer. The project also already ships
`convex/lib/filters.ts` as the backend `filter` arg shape and `useResolvedRange`
for live-window subscription stability; routing slots on top without touching
either.

### Watch-outs accepted with this choice (mitigations in §4)
- Learning curve of the `validateSearch` pattern (small; one documented example
  covers every tab).
- Conditionally import devtools (`import.meta.env.DEV`) so they don't ship.
- Package/version names drift fast — verify "latest" at install time (§2).

---

## 2. PACKAGES + Vite/provider setup

### Install

```bash
npm install @tanstack/react-router zod
npm install -D @tanstack/router-plugin @tanstack/react-router-devtools
```

- `@tanstack/react-router` — the router. Peer range covers React 19; bundle
  ≈ 40 KB gzip.
- `zod` — `validateSearch` schemas (we already coerce in `types.ts`; zod just
  shapes + guards the search object).
- `@tanstack/router-plugin` — Vite plugin. We start **code-based**, so the
  plugin is optional initially; install it for auto code-splitting and as the
  on-ramp to file-based routes later (see §4 phase notes). Import is
  `import { tanstackRouter } from "@tanstack/router-plugin/vite"` — **not** the
  older `@tanstack/router-vite-plugin` name some docs still show.
- `@tanstack/react-router-devtools` — dev only, conditionally imported.

> Versions move quickly; pin to whatever `npm view @tanstack/react-router
> version` reports at install time. This doc is the decision, not a lockfile.

### `vite.config.ts`

Plugin order matters: `tanstackRouter` **before** `@vitejs/plugin-react`. Only
add the plugin when/if we adopt code-splitting or file-based routes; the
code-based Phase 1 works with no Vite change.

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
// Optional (code-splitting / file-based on-ramp):
// import { tanstackRouter } from "@tanstack/router-plugin/vite";

export default defineConfig({
  plugins: [
    // tanstackRouter({ target: "react", autoCodeSplitting: true }),
    react(),
    tailwindcss(),
  ],
});
```

### Provider composition — `src/main.tsx`

`ConvexAuthProvider` stays the OUTERMOST app provider (its mandatory role is
documented in the current `main.tsx` comment: a plain `ConvexProvider` has no
token source and every `requireUserId()` throws). `RouterProvider` nests inside
it; `DialogsProvider` (today in `App.tsx`) moves to wrap the router or sits on
the root route component. `React.StrictMode` stays (Convex-supported).

```tsx
import React from "react";
import ReactDOM from "react-dom/client";
import { ConvexReactClient } from "convex/react";
import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import { routeTree } from "./router"; // §3
import { DialogsProvider } from "@/components/ConfirmDialog";
import "./index.css";
import "./chat/convexChat.css";

const convex = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL as string);
const router = createRouter({ routeTree, defaultPreload: "intent" });

// Global type registration — turns the whole app type-safe against the tree.
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ConvexAuthProvider client={convex}>
      <DialogsProvider>
        <RouterProvider router={router} />
      </DialogsProvider>
    </ConvexAuthProvider>
  </React.StrictMode>,
);
```

The single `ConvexReactClient` instance is created once and never recreated → the
WebSocket persists across client-side navigations (no reconnection thrash).

---

## 3. ROUTE TREE

### 3.1 Surfaces → routes

| Route | Surface | Today's state it replaces |
|---|---|---|
| `/` | Chat home (sidebar + empty/active chat pane) | `activeChatId === null`, `showSettings === false` |
| `/chat/$chatId` | A specific chat (bookmarkable, deep-linkable) | `activeChatId` |
| `/settings` | Settings shell; redirects to `/settings/users` | `showSettings === true` |
| `/settings/<tab>` | A settings sub-tab | `AdminSettings` `tab` state |

`<tab>` is one of the 11 existing tabs:
`users | groups | instances | serviceAccounts | roles | traces | kpi |
anomalies | integrations | theme | audit`. Note the routing **mechanism**: TanStack
Router's `validateSearch` receives only the raw *search* record — it cannot branch
on a path param. So a single dynamic `/settings/$tab` route cannot give each tab
its own typed search schema. We therefore declare **one static route per filtered
tab** (`/settings/traces`, `/settings/audit`, … each with its own static
`validateSearch`) and a shared `/settings/$tab` route only for the four paramless
tabs (`roles`, `integrations`, `instances`, `theme`). The user-facing URL shape is
still exactly `/settings/<tab>`. The tab list is validated against the existing
`TABS` tuple in `AdminSettings.tsx` (export it; the nav reuses it as the source of
truth so the routes and the nav can't drift).

`chatId` is a path param (the primary resource) — **not** a search param. Tab is
a path param too (each is a first-class destination), while **filter/time-range
state is search params** layered onto each filtered tab's static route. Settings is
admin-only; `roles`/`integrations`/`instances`/`theme` carry no search params (they
ride the shared `/settings/$tab` route).

### 3.2 The auth boundary becomes the root route

Today `AuthLoading` / `Unauthenticated` / pending-gate / `ChatWorkspace` all live
inside `ConvexChatApp`. Under routing the **root route component becomes that
shell** and only renders `<Outlet/>` when the user is `Authenticated` AND
`role !== "pending"`. This is load-bearing: if `<Outlet/>` mounts before auth
resolves, child routes fire `useQuery` unauthenticated and `requireUserId()`
throws. Each of the three states has a concrete home:

```tsx
// __root component (shell)
function RootShell() {
  return (
    <>
      <AuthLoading><div className="oc-boot">Chargement…</div></AuthLoading>
      <Unauthenticated><SignIn /></Unauthenticated>
      <Authenticated>
        <RoleGate>
          {/* ImpersonationBanner + AppTopBar + workspace chrome here */}
          <Outlet />
        </RoleGate>
      </Authenticated>
    </>
  );
}
```

- **AuthLoading** → boot spinner (no `<Outlet/>`).
- **Unauthenticated** → `<SignIn/>` (no `<Outlet/>`). No redirect needed; the
  boundary component swaps, the URL is preserved, and after sign-in the same URL
  re-renders authenticated. (Deep-link survives login for free.)
- **Authenticated + pending** → the pending screen (no `<Outlet/>`); the
  `ImpersonationBanner` + `UserMenu` stay reachable exactly as today.
- **Authenticated + active** → render chrome (banner, top bar, sidebar) + the
  matched child route via `<Outlet/>`.

**Admin gate for `/settings/*`:** non-admins must not reach settings.
`requireAdmin` already enforces this server-side (the UI is convenience, not the
boundary). In the router, the `/settings` route's `beforeLoad` reads role from
context and `throw redirect({ to: "/" })` for non-admins. Role comes from
`api.me.getMe`; expose it to the router via router `context` (set once the
`RoleGate` has `me`) OR guard inside the settings component with the existing
`useQuery(api.me.getMe)` and redirect via `useNavigate` — pick the component
guard for Phase 2 (simplest, no context plumbing), promote to `beforeLoad` later.

**Impersonation remount (`key={me.userId}`):** today `ChatWorkspace` is keyed on
`me.userId` so starting/stopping impersonation hard-resets transient UI (the
selected chat). Two ways to preserve the invariant under routing — choose one and
state it in the PR:
1. Keep `key={me.userId}` on the authenticated chrome wrapper inside the root
   shell (mechanically identical to today; transient *route* state like an open
   chat is reset because the subtree remounts — but the URL still points at the
   old chat). **Plus** an effect: on `me.userId` change, `navigate({ to: "/" })`
   so the URL can't point at a chat the new effective identity can't read.
2. Drop the key, rely on `navigate({ to: "/" })` on identity flip alone.

Recommend **(1)** — it keeps the proven remount AND fixes the
URL-points-at-foreign-chat hole that routing introduces.

### 3.3 Code-based tree (single file, `src/router.tsx`)

Code-based (not file-based) for the migration: one reviewable source of truth,
which is also the artifact agents read for the URL contract. File-based is an
optional later refactor (§4).

Each **filtered** tab is its own static route carrying its own `validateSearch`
(the only mechanism that gives a per-tab typed search object — see the §3.3 header
note). The four paramless tabs share one `$tab` route. `validateSearch` is `(raw)
=> schema.parse(raw)` and receives **only** the search record (never the path
param), which is exactly why per-tab schemas must be per-route.

```tsx
import { createRootRoute, createRoute, redirect, Outlet } from "@tanstack/react-router";
import { z } from "zod";
import { TABS } from "@/chat/AdminSettings";        // export the existing tuple
import {
  tracesSearchSchema, auditSearchSchema, anomaliesSearchSchema,
  kpiSearchSchema, serviceAccountsSearchSchema,
  usersSearchSchema, groupsSearchSchema,
} from "@/lib/routing/searchSchemas"; // §3.4

const rootRoute = createRootRoute({ component: RootShell });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute, path: "/", component: ChatHome,
});

const chatRoute = createRoute({
  getParentRoute: () => rootRoute, path: "chat/$chatId", component: ChatScreen,
});

// Settings shell: admin guard + bare /settings redirect to the first tab.
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute, path: "settings",
  beforeLoad: () => {
    // Phase 2: component guard via api.me.getMe instead; beforeLoad once role
    // is in router context.
  },
});
const settingsIndexRoute = createRoute({
  getParentRoute: () => settingsRoute, path: "/",
  beforeLoad: () => { throw redirect({ to: "/settings/users" }); },
});

// One STATIC route per filtered tab → one typed validateSearch each.
const tracesRoute = createRoute({
  getParentRoute: () => settingsRoute, path: "traces",
  validateSearch: (raw) => tracesSearchSchema.parse(raw),
  component: TracesScreen,
});
const auditRoute = createRoute({
  getParentRoute: () => settingsRoute, path: "audit",
  validateSearch: (raw) => auditSearchSchema.parse(raw),
  component: AuditScreen,
});
const anomaliesRoute = createRoute({
  getParentRoute: () => settingsRoute, path: "anomalies",
  validateSearch: (raw) => anomaliesSearchSchema.parse(raw),
  component: AnomaliesScreen,
});
const kpiRoute = createRoute({
  getParentRoute: () => settingsRoute, path: "kpi",
  validateSearch: (raw) => kpiSearchSchema.parse(raw),
  component: KpiScreen,
});
const serviceAccountsRoute = createRoute({
  getParentRoute: () => settingsRoute, path: "serviceAccounts",
  validateSearch: (raw) => serviceAccountsSearchSchema.parse(raw),
  component: ServiceAccountsScreen,
});
const usersRoute = createRoute({
  getParentRoute: () => settingsRoute, path: "users",
  validateSearch: (raw) => usersSearchSchema.parse(raw),
  component: UsersScreen,
});
const groupsRoute = createRoute({
  getParentRoute: () => settingsRoute, path: "groups",
  validateSearch: (raw) => groupsSearchSchema.parse(raw),
  component: GroupsScreen,
});

// Paramless tabs (roles | integrations | instances | theme): one shared route.
const PARAMLESS = ["roles", "integrations", "instances", "theme"] as const;
const settingsTabRoute = createRoute({
  getParentRoute: () => settingsRoute, path: "$tab",
  parseParams: (p) => ({ tab: z.enum(PARAMLESS).catch("roles").parse(p.tab) }),
  component: SettingsParamlessScreen,
});

export const routeTree = rootRoute.addChildren([
  indexRoute, chatRoute,
  settingsRoute.addChildren([
    settingsIndexRoute,
    tracesRoute, auditRoute, anomaliesRoute, kpiRoute,
    serviceAccountsRoute, usersRoute, groupsRoute,
    settingsTabRoute,
  ]),
]);
```

> `z.enum(TABS)` / `z.enum(PARAMLESS)` over an `as const` readonly tuple is fine on
> current zod; if TS complains, spread to a mutable tuple (`[...PARAMLESS]`).
> There is no `settingsSearchByTab` dispatcher — each route owns its schema.

### 3.4 Filter / time-range state → validated search params

This is the crux. Grounded in the actual per-tab `useState` (verified by reading
each file), here is exactly which tab carries which search params:

| Route (`/settings/<tab>`) | Search params (URL keys) | Source state today |
|---|---|---|
| `traces` | `q`, `kind`, `limit`, `statusClass`, `principalType`, `direction`, `roleKey`, `from`, `to`, `adv` | TracesTab `useState` (q, kind, limit, statusClassFilter, principalType, direction, roleKey, range, advanced) |
| `audit` | `q`, `action`, `impersonated`, `resource`, `from`, `to`, `adv` | AuditTab `useState` |
| `anomalies` | `q`, `status` (anomalyStatus), `severity`, `kind`, `from`, `to` | AnomaliesTab `useState` |
| `kpi` | `from`, `to` | KpiTab `useState` (range only) |
| `serviceAccounts` | `q`, `status` (statusFilter) | ServiceAccountsTab `useState` |
| `users` | `q`, `role` | inline UsersTab `useState` |
| `groups` | `q`, `mode` | inline GroupsTab `useState` |
| `roles`, `integrations`, `instances`, `theme` | *(none)* | no filter state |

> Client-only ephemerals stay in `useState`, NOT the URL: TracesTab's
> `followCorr` and `metaRow` (transient dialog/selection), and KPI's derived
> grouping. Rule of thumb: if losing it on refresh is acceptable, keep it local.

#### CRITICAL: the URL stores time-range TOKENS, never resolved epochs

`useResolvedRange` does a 30 s tick + minute-snap so the Convex subscription arg
is stable between ticks (Convex keys subscriptions on serialized arg values —
resolved `Date.now()` bounds in the URL would change every 30 s → history spam +
subscription churn + loading flicker). Therefore the pipeline is:

```
URL  ?from=now-30d&to=now      (relative TOKENS — Grafana-style)
  → validateSearch → TimeRange (discriminated union from types.ts)
  → useResolvedRange(range)     (STAYS at component level → 30s tick + minute snap)
  → { from, to } epoch ms
  → useQuery(api.*, { filter: { from, to, ... } })
```

Resolved epochs **never** touch the URL. A relative range stays *live* across
bookmark/refresh (re-resolves to "now" on load) AND the subscription stays
stable. An absolute range serializes as `from=<epochMs>&to=<epochMs>` and is
fixed. The `TimeRange` union already encodes exactly this relative/absolute split
— the search schema is a thin (de)serializer over it.

#### `adv` (advanced predicates) encoding — PINNED

`Predicate[]` (`{ field, op, value }[]`) serializes as **one URL-safe JSON
param**: `adv=<encodeURIComponent(JSON.stringify(predicates))>`. Chosen over a
delimited `field:op:value` chain because predicate `value` is `string | number |
boolean` and a free-text string can contain the delimiter; JSON sidesteps
escaping entirely and round-trips through the existing `coercePredicateValue`
typing. Decode validates each row against `Op` + coerces the value, dropping
malformed rows (robust degradation). For pathological cases (20+ predicates →
URL length), fall back to dropping `adv` from the URL and keeping it local —
acceptable since advanced filters are an admin power-tool, not a primary
deep-link target. (Decision pinned; do not leave the format open.)

#### Search-schema module — `src/lib/routing/searchSchemas.ts`

One zod schema per filtered tab, each delegating coercion to `types.ts` (no
re-derivation). Sketch for traces:

```ts
import { z } from "zod";
import type { TimeRange, Predicate, Op } from "@/chat/admin/filters/types";

const OPS = ["eq","neq","contains","gt","gte","lt","lte"] as const;

// from/to: relative token string OR absolute epoch number; default relative.
function decodeRange(from?: string, to?: string): TimeRange {
  const f = from ?? "now-30d", t = to ?? "now";
  const fn = Number(f), tn = Number(t);
  if (Number.isFinite(fn) && Number.isFinite(tn))
    return { kind: "absolute", from: fn, to: tn };
  return { kind: "relative", from: f, to: t };
}

export const tracesSearchSchema = z.object({
  q: z.string().optional(),
  kind: z.string().default("all"),
  limit: z.coerce.number().int().pipe(z.union([z.literal(50),z.literal(100),
          z.literal(200),z.literal(500)])).catch(100),
  statusClass: z.enum(["2xx","4xx","5xx"]).optional(),
  principalType: z.enum(["user","service","system"]).optional(),
  direction: z.enum(["inbound","outbound","internal"]).optional(),
  roleKey: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  adv: z.string().optional(), // JSON; parsed → Predicate[] by a helper, see above
});
// component derives `range = decodeRange(search.from, search.to)` then
// `useResolvedRange(range)`; `advanced = parseAdv(search.adv)`.
```

Each tab's static route uses its own schema as `validateSearch: (raw) =>
tracesSearchSchema.parse(raw)` (§3.3); `.catch(...)` / `.optional()` make malformed
input fall to safe defaults in ONE place. There is no per-tab dispatcher — the
one-route-per-filtered-tab structure (§3.3) is what makes `useSearch()` return the
*active tab's* exact typed subset, not a loose superset.

#### Reading/writing search params in a tab

- Read: `const search = tracesRoute.useSearch();` (fully typed to that tab).
- Write a filter change:
  `navigate({ search: (prev) => ({ ...prev, statusClass: v }) })`.
- **History discipline (per control):**
  - `q` free-text box → **`replace: true` + debounce** (~300–500 ms) so typing
    doesn't spam the back stack or thrash the subscription.
  - Quick `<Select>`s, time-range pick, `adv` apply, tab switch, chat open →
    **push** (normal `navigate`/`<Link>`), so Back restores the prior state.

#### AI-drivability contract

Because the search schema *is* the contract, an agent constructs e.g.:
`/settings/traces?from=now-7d&to=now&statusClass=5xx&principalType=service` →
"5xx traces from service principals in the last 7 days". The route file +
`searchSchemas.ts` are the two artifacts to point an agent at. (Optional later:
export typed URL-builder helpers, e.g. `buildTracesUrl(...)`, for zero-guess
construction and to unit-test the contract.)

### 3.5 How state-driven `ConvexChatApp` maps onto the tree

| Today | Becomes |
|---|---|
| `useState activeChatId` in `ChatWorkspace` | `/chat/$chatId` param; `ChatSidebar.onSelect` → `navigate({ to: "/chat/$chatId", params })` instead of `setActiveChatId` |
| `useState showSettings` + Settings button | `<Link to="/settings/users">` (or any tab); active state = `useMatchRoute`/`isActive` |
| `AdminSettings` `useState tab` + nav buttons | per-tab route (`/settings/users`, …); tab nav = `<Link>`s; `setTab` removed |
| per-tab filter `useState` | `validateSearch` search params (§3.4); `setQ`/`setRange`/… become `navigate({ search })` |
| `AuthLoading/Unauthenticated/pending` in `ConvexChatApp` | root-route shell (§3.2) |
| `key={me.userId}` remount | kept on authenticated chrome wrapper + `navigate("/")` on identity flip (§3.2) |

The sidebar, top bar, impersonation banner, theme application (`useApplyTheme`),
and `useSidebarLayout` are **persistent chrome** → they live on the root shell
(above `<Outlet/>`), so they don't unmount on navigation and keep their state.

---

## 4. MIGRATION RISKS + PHASED PLAN

### Risks (and mitigations)

1. **Auth/Outlet ordering** — child route fires `useQuery` before auth resolves →
   `requireUserId()` throws. *Mitigation:* `<Outlet/>` renders only inside
   `<Authenticated>` + active-role branch of the root shell (§3.2). This is the
   #1 thing to get right.
2. **Time-range in URL done wrong** — writing resolved epochs → 30 s history spam
   + subscription churn. *Mitigation:* URL holds TOKENS; `useResolvedRange` stays
   at component level; epochs never serialized (§3.4). The #2 thing to get right.
3. **Impersonation can leave the URL on a foreign chat** — routing introduces a
   hole the old pure-state UI didn't have. *Mitigation:* keep `key={me.userId}`
   AND `navigate("/")` on `me.userId` change (§3.2).
4. **Admin guard** — non-admin lands on `/settings/*`. *Mitigation:* component
   guard via `api.me.getMe` + redirect now; `beforeLoad` later. Server
   `requireAdmin` is the real boundary regardless.
5. **History spam from filter typing** — every keystroke a history entry.
   *Mitigation:* `replace: true` + debounce for `q`; push for everything else.
6. **Search-param drift / silent data loss** — a filter not wired to the URL
   resets on refresh. *Mitigation:* the §3.4 table is the checklist; a unit test
   per schema asserts round-trip (encode→decode→equal) and default-on-garbage.
7. **Predicate URL length** — 20+ predicates exceed sane URL length.
   *Mitigation:* JSON `adv`; on overflow, drop from URL + keep local (§3.4).
8. **Devtools / plugin-name footguns** — devtools shipped to prod; wrong plugin
   import name. *Mitigation:* `import.meta.env.DEV`-gate devtools; use
   `@tanstack/router-plugin/vite` (`tanstackRouter`), not the legacy name.
9. **Convex Auth beta (0.0.80)** — pre-1.0, breaking changes possible.
   *Mitigation:* version-locked already; routing change is orthogonal to auth.

### Phased plan

**Phase 0 — scaffold (½ day).** Install deps. Add `src/router.tsx` with root +
`/` only; move the `AuthLoading/Unauthenticated/RoleGate` shell from
`ConvexChatApp` into the root route component; render `<Outlet/>`; `/` renders
the existing chat workspace chrome. Verify: sign-in, pending, active, and
impersonation banner all still work; chrome persists. No behavior change visible
to users yet. Ship.

**Phase 1 — chat deep-links (½–1 day).** Add `/chat/$chatId`. `ChatSidebar`
selection → `navigate`; `ConvexChat` reads `useParams().chatId`. Drop
`activeChatId` `useState`. Add the `me.userId` → `navigate("/")` effect. Verify:
open a chat, copy URL, refresh in a new tab → same chat; Back/Forward traverse
chats; start/stop impersonation returns to `/`.

**Phase 2 — settings tabs (½–1 day).** Export `TABS` from `AdminSettings`. Add
the `/settings` shell (bare `/settings` redirect → `/settings/users` + admin
guard), the per-tab static routes for the filtered tabs, and the shared
`/settings/$tab` route for the four paramless tabs (§3.3). Replace tab
`useState`/buttons with `<Link>`s. Verify: `/settings/theme` bookmarks; non-admin
redirected; unknown paramless tab → `roles`.

**Phase 3 — filter search params (1–2 days).** Add
`src/lib/routing/searchSchemas.ts` (one schema per filtered tab, delegating to
`types.ts`). Wire each schema as that tab route's `validateSearch` (§3.3).
Migrate, tab by tab in
this order: `traces` (richest, proves the pattern) → `audit` → `anomalies` →
`kpi` → `serviceAccounts` → `users` → `groups`. Per tab: replace filter
`useState` with `useSearch` + `navigate({ search })`; keep `useResolvedRange` at
component level; apply history discipline (debounce/replace for `q`). Add
round-trip + default-on-garbage unit tests per schema (Vitest is already in the
stack). Verify each: copy a filtered URL, refresh → identical filters + live
range; malformed param → safe default, no crash.

**Phase 4 — polish (optional, ½ day).** Dev-gated `TanStackRouterDevtools`;
exported `buildXUrl` helpers + this doc's contract section for agents;
*optionally* migrate code-based → file-based via `@tanstack/router-plugin`
(`autoCodeSplitting`) once routes stabilize. Pause-point: re-evaluate before
investing here.

Total ≈ 3–5 focused days. Each phase is independently shippable and reversible;
Convex backend (`convex/lib/filters.ts`, every query's `filter` arg) is
unchanged throughout — routing is purely a frontend state-relocation.
