// Code-based TanStack Router route tree (the single reviewable source of truth
// AND the artifact agents read for the URL contract). See
// docs/ROUTING_RESEARCH.md §3 for the full decision.
//
// Structure:
//   __root  = the AUTH BOUNDARY + persistent chrome (RootShell). <Outlet/> only
//             renders for Authenticated + active-role users (§3.2 — the #1 risk:
//             an Outlet that mounts before auth resolves fires unauthenticated
//             useQuery and requireUserId() throws).
//   /                       chat home (empty pane)
//   /chat/$chatId           a specific chat (deep-linkable)
//   /settings               admin-guarded layout (tab nav + ToastProvider)
//     /settings (index)     → redirect to /settings/users
//     /settings/<filtered>  one STATIC route per filtered tab, each with its own
//                           typed validateSearch (the only way to give a tab its
//                           own search schema — validateSearch sees only search,
//                           never the path param)
//     /settings/$tab        shared route for the 4 PARAMLESS tabs
//                           (roles/integrations/instances/theme)

import { useEffect, useRef, useState } from "react";
import {
  Authenticated,
  AuthLoading,
  Unauthenticated,
  useMutation,
  useQuery,
} from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import {
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
  Outlet,
  useNavigate,
  useParams,
  type ErrorComponentProps,
} from "@tanstack/react-router";
import { z } from "zod";
import {
  Eye,
  PanelLeftClose,
  PanelLeftOpen,
  AlertTriangle,
  Compass,
} from "lucide-react";
import { api } from "./chat/convexApi";
import type { Id } from "./chat/convexApi";
import type { ConvexId } from "./chat/convexTypes";
import { ConvexChat } from "./chat/ConvexChat";
import { ChatSidebar } from "./chat/ChatSidebar";
import { UserMenu } from "./chat/UserMenu";
import { NotificationBell } from "./chat/NotificationBell";
import { GlobalSearch } from "./chat/GlobalSearch";
import {
  TABS,
  TAB_LABELS,
  PARAMLESS_TABS,
  UsersTab,
  GroupsTab,
  InstancesTab,
  AuditTab,
  type Tab,
  type ParamlessTab,
} from "./chat/AdminSettings";
import { ServiceAccountsTab } from "./chat/admin/ServiceAccountsTab";
import { RolesTab } from "./chat/admin/RolesTab";
import { TracesTab } from "./chat/admin/TracesTab";
import { KpiTab } from "./chat/admin/KpiTab";
import { AnomaliesTab } from "./chat/admin/AnomaliesTab";
import { IntegrationsTab } from "./chat/admin/IntegrationsTab";
import { FeedbacksTab } from "./chat/admin/FeedbacksTab";
import { UiPrefsTab } from "./chat/admin/UiPrefsTab";
import { BridgeTab } from "./chat/admin/BridgeTab";
import { SettingsNav } from "./chat/admin/SettingsNav";
import { ThemeShowroom } from "./chat/ThemeShowroom";
import {
  tracesSearchSchema,
  auditSearchSchema,
  anomaliesSearchSchema,
  kpiSearchSchema,
  serviceAccountsSearchSchema,
  usersSearchSchema,
  groupsSearchSchema,
} from "./lib/routing/searchSchemas";
import { Button } from "@/components/ui/button";
import { ToastProvider } from "@/components/ui/toast";
import { useApplyTheme, type ThemeMode } from "@/lib/useTheme";
import { useSidebarLayout } from "@/lib/useSidebarLayout";
import { Link, useMatchRoute } from "@tanstack/react-router";

// What getMe returns (the bits the shell needs). `userId` is the EFFECTIVE id
// (impersonation-aware) — used as a remount key so switching identity resets
// transient UI (e.g. the selected chat) cleanly.
type Me = {
  userId: string;
  role: "pending" | "user" | "admin";
  email: string | null;
  name: string | null;
  hasProfile: boolean;
  themeMode: ThemeMode | null;
  resolvedThemeMode: ThemeMode;
  defaultThemeMode: ThemeMode | null;
};

// ===========================================================================
// ROOT SHELL — the auth boundary (§3.2). <Outlet/> renders ONLY inside
// <Authenticated> AND when role !== "pending".
// ===========================================================================

function RootShell() {
  return (
    <>
      <AuthLoading>
        <div className="oc-boot">Chargement…</div>
      </AuthLoading>
      <Unauthenticated>
        <SignIn />
      </Unauthenticated>
      <Authenticated>
        <RoleGate />
      </Authenticated>
    </>
  );
}

function SignIn() {
  const { signIn } = useAuthActions();
  // Which providers the deployment enabled (env-driven, server-resolved). Pre-auth
  // query → no identity required.
  const providers = useQuery(api.me.authProviders);
  const [error, setError] = useState<string | null>(null);
  // OAuth sign-in, restricted server-side to the allowed email domains
  // (convex/lib/authDomains). On a disallowed account the OAuth flow is rejected
  // server-side; surface a clear message instead of a silent failure.
  async function oauth(provider: string) {
    setError(null);
    try {
      await signIn(provider);
    } catch {
      setError(
        "Connexion refusée. Comptes autorisés : @lacneu.com et @ataraxis-coaching.com.",
      );
    }
  }
  const noneEnabled =
    providers !== undefined &&
    !providers.google &&
    !providers.microsoft &&
    !providers.anonymous;
  return (
    <div className="oc-signin">
      {providers?.google ? (
        <button type="button" className="oc-signin__btn" onClick={() => void oauth("google")}>
          Se connecter avec Google
        </button>
      ) : null}
      {providers?.microsoft ? (
        <button
          type="button"
          className="oc-signin__btn"
          onClick={() => void oauth("microsoft-entra-id")}
        >
          Se connecter avec Microsoft
        </button>
      ) : null}
      {error ? <p className="oc-signin__error">{error}</p> : null}
      {noneEnabled ? (
        <p className="oc-signin__error">Aucun mode de connexion configuré.</p>
      ) : null}
      {providers?.anonymous ? (
        <button
          type="button"
          className="oc-signin__btn oc-signin__btn--dev"
          onClick={() => void signIn("anonymous")}
        >
          Continue (dev, no account)
        </button>
      ) : null}
    </div>
  );
}

// After authentication, provision the profile once (me.bootstrap — the only
// mutation a pending user may call) and route by role. RoleGate does NOT remount
// on navigation (only the inner chrome wrapper is keyed), so the impersonation
// effect below lives here.
function RoleGate() {
  const me = useQuery(api.me.getMe) as Me | undefined;
  const bootstrap = useMutation(api.me.bootstrap);
  const navigate = useNavigate();

  // Create the profile on first sight (idempotent). me.getMe then reflects the
  // assigned role reactively.
  useEffect(() => {
    if (me && !me.hasProfile) {
      void bootstrap();
    }
  }, [me, bootstrap]);

  // Apply the Convex-resolved theme (source of truth). undefined until getMe
  // loads -> the hook falls back to the localStorage cache (no flash).
  useApplyTheme(me?.resolvedThemeMode);

  // Impersonation safety (§3.2 option 1): on a REAL change of effective identity
  // (start/stop impersonation), send the URL back to "/" so it can't point at a
  // chat the new effective identity can't read. Detect a genuine CHANGE, not the
  // first authenticated mount — otherwise a deep-linked /chat/x is clobbered on
  // initial load (breaking "deep-link survives login"). Declared ABOVE the early
  // returns so the hook order is stable.
  const prevUserId = useRef<string | null>(null);
  useEffect(() => {
    if (!me) return;
    if (prevUserId.current !== null && prevUserId.current !== me.userId) {
      void navigate({ to: "/" });
    }
    prevUserId.current = me.userId;
  }, [me, navigate]);

  if (me === undefined) return <div className="oc-boot">Chargement…</div>;

  const userLabel = me.name || me.email || "Compte";

  if (me.role === "pending") {
    return (
      <div className="oc-shell">
        <ImpersonationBanner />
        <header className="oc-topbar">
          <span className="oc-topbar__brand">OpenClaw</span>
          <div className="oc-topbar__actions">
            <UserMenu label={userLabel} mode={me.themeMode} minimal />
          </div>
        </header>
        <div className="oc-pending">
          <h1 className="oc-pending__title">En attente d’approbation</h1>
          <p className="oc-pending__body">
            Ton compte est créé mais doit être approuvé par un administrateur
            avant d’accéder au chat.
          </p>
        </div>
      </div>
    );
  }

  return (
    <AuthenticatedChrome
      // Remount on identity change (start/stop impersonation) so transient UI
      // (sidebar local state etc.) hard-resets cleanly, mirroring the previous
      // key on ChatWorkspace. The navigate("/") effect above closes the
      // URL-points-at-foreign-chat hole that routing would otherwise open.
      key={me.userId}
      isAdmin={me.role === "admin"}
      userLabel={userLabel}
      themeMode={me.themeMode}
    />
  );
}

// Persistent warning strip shown whenever the admin is impersonating a user.
// Driven by me.getImpersonation (REAL-identity query, so it survives the
// effective-identity flip it reports on). Rendered on EVERY authenticated
// surface (incl. the pending screen) so "Quitter" is always reachable.
function ImpersonationBanner() {
  const imp = useQuery(api.me.getImpersonation) as
    | { impersonating: false }
    | {
        impersonating: true;
        targetLabel: string;
        targetRole: string;
        realLabel: string;
      }
    | undefined;
  const stop = useMutation(api.admin.stopImpersonation);
  if (!imp || !imp.impersonating) return null;
  return (
    <div className="oc-imp" role="alert">
      <Eye className="size-4 shrink-0" />
      <span className="oc-imp__text">
        Vous explorez l’application en tant que{" "}
        <strong>{imp.targetLabel}</strong>. Toute action est exécutée et tracée
        en votre nom (<strong>{imp.realLabel}</strong>).
      </span>
      <Button
        size="sm"
        variant="outline"
        className="oc-imp__exit"
        onClick={() => void stop()}
      >
        Quitter
      </Button>
    </div>
  );
}

// Global top bar: sidebar toggle (left) + brand + single user menu (right).
function AppTopBar({
  userLabel,
  themeMode,
  collapsed,
  onToggleSidebar,
}: {
  userLabel: string;
  themeMode: ThemeMode | null;
  collapsed: boolean;
  onToggleSidebar: () => void;
}) {
  return (
    <header className="oc-topbar">
      <div className="oc-topbar__left">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={collapsed ? "Afficher la barre latérale" : "Réduire la barre latérale"}
          onClick={onToggleSidebar}
        >
          {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
        </Button>
        {/* Brand returns to the chat surface (leaving Settings). */}
        <Link to="/" className="oc-topbar__brand">
          OpenClaw
        </Link>
      </div>
      {/* Center zone: global conversation search (⌘K palette). */}
      <div className="oc-topbar__search">
        <GlobalSearch />
      </div>
      <div className="oc-topbar__actions">
        <NotificationBell />
        <UserMenu label={userLabel} mode={themeMode} />
      </div>
    </header>
  );
}

// The authenticated, active-role chrome: impersonation banner + top bar +
// persistent sidebar, with the matched route rendered via <Outlet/>. This is
// the PERSISTENT CHROME — it does not unmount on navigation, so the sidebar
// layout + scroll position survive route changes (§3.5).
function AuthenticatedChrome({
  isAdmin,
  userLabel,
  themeMode,
}: {
  isAdmin: boolean;
  userLabel: string;
  themeMode: ThemeMode | null;
}) {
  const { width, collapsed, toggleCollapsed, startResize } = useSidebarLayout();
  const matchRoute = useMatchRoute();
  // Active-chat highlight: read the chatId param without requiring a match on a
  // specific route (strict:false → undefined off the chat route).
  const params = useParams({ strict: false }) as { chatId?: string };
  const navigate = useNavigate();
  // Settings is active when any /settings/* route matches (fuzzy).
  const settingsActive = Boolean(matchRoute({ to: "/settings", fuzzy: true }));

  return (
    <div className="oc-shell">
      <ImpersonationBanner />
      <AppTopBar
        userLabel={userLabel}
        themeMode={themeMode}
        collapsed={collapsed}
        onToggleSidebar={toggleCollapsed}
      />
      <div className="oc-workspace">
        {!collapsed ? (
          <div
            className="oc-sidebar-col"
            style={{ width, flex: `0 0 ${width}px` }}
          >
            {/* In Settings, the chat list is replaced by a VERTICAL settings nav
                (the chat "disappears"); a top-bar / back link returns to chat. */}
            {settingsActive ? (
              <SettingsNav />
            ) : (
              <>
                <ChatSidebar
                  activeChatId={(params.chatId ?? null) as Id<"chats"> | null}
                  onSelect={(id) =>
                    void navigate({ to: "/chat/$chatId", params: { chatId: id } })
                  }
                />
                {isAdmin ? (
                  <Button variant="ghost" className="m-2 justify-start" asChild>
                    <Link to="/settings/users">Settings</Link>
                  </Button>
                ) : null}
              </>
            )}
            {/* Resize handle on the right edge. */}
            <div
              className="oc-sidebar-resizer"
              onPointerDown={startResize}
              role="separator"
              aria-orientation="vertical"
              aria-label="Redimensionner la barre latérale"
            />
          </div>
        ) : null}
        <main className="oc-main">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

// ===========================================================================
// SETTINGS LAYOUT — admin guard + tab nav + ToastProvider, with the matched tab
// route rendered via <Outlet/>. ToastProvider must wrap the Outlet so every
// tab's useToast() resolves (it previously wrapped the whole AdminSettings).
// ===========================================================================

// TabLink, the FilteredTabPath union, and the (now drag-and-drop, per-user
// persisted) vertical SettingsNav moved to ./chat/admin/SettingsNav.tsx.

function SettingsLayout() {
  // Admin guard (Phase 2: component guard via api.me.getMe + redirect; the
  // server requireAdmin is the real boundary regardless). While me is loading
  // we render nothing destructive; a non-admin is redirected to "/".
  const me = useQuery(api.me.getMe) as Me | undefined;
  const navigate = useNavigate();
  useEffect(() => {
    if (me && me.role !== "admin") {
      void navigate({ to: "/" });
    }
  }, [me, navigate]);

  if (me === undefined) {
    return <div className="oc-admin__hint" style={{ padding: 16 }}>Chargement…</div>;
  }
  if (me.role !== "admin") return null; // redirecting

  // The tab nav now lives in the VERTICAL SettingsNav (left column, rendered by
  // AuthenticatedChrome). This layout keeps only the content: the always-on
  // bridge health bar + the active tab.
  // Bridge health moved OUT of an always-on banner into its own "Bridge" tab
  // (badge on the tab + detailed view on click). The layout keeps only the
  // active tab content.
  return (
    <ToastProvider>
      <div className="oc-admin">
        <div className="oc-admin__body">
          <Outlet />
        </div>
      </div>
    </ToastProvider>
  );
}

// Paramless tab dispatcher: the four tabs that carry no search params share one
// `$tab` route. The param is validated to the closed set (catch → "roles").
function SettingsParamlessScreen() {
  const { tab } = useParams({ from: "/settings/$tab" });
  switch (tab) {
    case "integrations":
      return <IntegrationsTab />;
    case "instances":
      return <InstancesTab />;
    case "bridge":
      return <BridgeTab />;
    case "theme":
      return <ThemeShowroom />;
    case "feedbacks":
      return <FeedbacksTab />;
    case "uiprefs":
      return <UiPrefsTab />;
    case "roles":
    default:
      return <RolesTab />;
  }
}

// Chat route screen: reads the chatId path param and feeds the chat surface.
function ChatScreen() {
  const { chatId } = useParams({ from: "/chat/$chatId" });
  return <ConvexChat chatId={chatId as ConvexId<"chats">} />;
}

// Chat home: no chat selected (the empty pane).
function ChatHome() {
  return <ConvexChat chatId={null} />;
}

// ===========================================================================
// ROUTE TREE
// ===========================================================================

const rootRoute = createRootRoute({ component: RootShell });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: ChatHome,
});

const chatRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "chat/$chatId",
  component: ChatScreen,
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "settings",
  component: SettingsLayout,
});

const settingsIndexRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/settings/users" });
  },
});

// One STATIC route per FILTERED tab → one typed validateSearch each.
const tracesRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "traces",
  validateSearch: tracesSearchSchema,
  component: TracesTab,
});
const auditRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "audit",
  validateSearch: auditSearchSchema,
  component: AuditTab,
});
const anomaliesRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "anomalies",
  validateSearch: anomaliesSearchSchema,
  component: AnomaliesTab,
});
const kpiRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "kpi",
  validateSearch: kpiSearchSchema,
  component: KpiTab,
});
const serviceAccountsRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "serviceAccounts",
  validateSearch: serviceAccountsSearchSchema,
  component: ServiceAccountsTab,
});
const usersRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "users",
  validateSearch: usersSearchSchema,
  component: UsersTab,
});
const groupsRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "groups",
  validateSearch: groupsSearchSchema,
  component: GroupsTab,
});

// Paramless tabs (roles | integrations | instances | theme): one shared route.
const settingsTabRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "$tab",
  parseParams: (p) => ({
    tab: z.enum([...PARAMLESS_TABS]).catch("roles").parse(p.tab),
  }),
  component: SettingsParamlessScreen,
});

// Router-wide error fallback (the safety net). TanStack renders this IN the
// nearest parent route boundary — i.e. inside RootShell's <Outlet> — so the app
// shell (sidebar + top bar) survives and the user never sees the raw
// "Something went wrong" screen with a thrown stack. We deliberately do NOT
// render `error.message` (it can carry "Forbidden: chat not owned by user" or
// other internal detail) — the message stays generic; details live in logs.
function RouteError({ reset }: ErrorComponentProps) {
  const navigate = useNavigate();
  return (
    <div className="oc-route-error" role="alert">
      <div className="oc-route-error__icon" aria-hidden>
        <AlertTriangle size={28} />
      </div>
      <h2 className="oc-route-error__title">Une erreur est survenue</h2>
      <p className="oc-route-error__body">
        Cette page n’a pas pu être affichée. Réessayez, ou revenez à l’accueil. Si
        le problème persiste, contactez votre administrateur.
      </p>
      <div className="oc-route-error__actions">
        <button type="button" className="oc-route-error__cta" onClick={() => reset()}>
          Réessayer
        </button>
        <button
          type="button"
          className="oc-route-error__cta oc-route-error__cta--ghost"
          onClick={() => void navigate({ to: "/" })}
        >
          Accueil
        </button>
      </div>
    </div>
  );
}

// Unknown URL fallback (also rendered inside the shell). Same friendly, in-app
// treatment as a not-found chat rather than a bare router default.
function RouteNotFound() {
  const navigate = useNavigate();
  return (
    <div className="oc-route-error" role="status">
      <div className="oc-route-error__icon" aria-hidden>
        <Compass size={28} />
      </div>
      <h2 className="oc-route-error__title">Page introuvable</h2>
      <p className="oc-route-error__body">
        Cette adresse ne correspond à aucune page de l’application.
      </p>
      <div className="oc-route-error__actions">
        <button
          type="button"
          className="oc-route-error__cta"
          onClick={() => void navigate({ to: "/" })}
        >
          Accueil
        </button>
      </div>
    </div>
  );
}

const routeTree = rootRoute.addChildren([
  indexRoute,
  chatRoute,
  settingsRoute.addChildren([
    settingsIndexRoute,
    tracesRoute,
    auditRoute,
    anomaliesRoute,
    kpiRoute,
    serviceAccountsRoute,
    usersRoute,
    groupsRoute,
    settingsTabRoute,
  ]),
]);

export const router = createRouter({
  routeTree,
  defaultPreload: "intent",
  // App-shell-preserving fallbacks (see RouteError / RouteNotFound). Without
  // these, an unexpected throw in any route surfaces TanStack's raw default
  // error screen outside the application chrome.
  defaultErrorComponent: RouteError,
  defaultNotFoundComponent: RouteNotFound,
});

// Global type registration — makes the whole app type-safe against the tree.
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
