import { useEffect, useState } from "react";
import {
  Authenticated,
  AuthLoading,
  Unauthenticated,
  useMutation,
  useQuery,
} from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import {
  Settings as SettingsIcon,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import { api } from "./convexApi";
import type { ConvexId } from "./convexTypes";
import type { Id } from "./convexApi";
import { ConvexChat } from "./ConvexChat";
import { AdminSettings } from "./AdminSettings";
import { UserMenu } from "./UserMenu";
import { ChatSidebar } from "./ChatSidebar";
import { Button } from "@/components/ui/button";
import { useApplyTheme, type ThemeMode } from "@/lib/useTheme";
import { useSidebarLayout } from "@/lib/useSidebarLayout";

// What getMe returns (the bits the shell needs).
type Me = {
  role: "pending" | "user" | "admin";
  email: string | null;
  name: string | null;
  hasProfile: boolean;
  themeMode: ThemeMode | null;
  resolvedThemeMode: ThemeMode;
  defaultThemeMode: ThemeMode | null;
};

// Top-level app shell. Auth boundary uses Convex Auth's
// <Authenticated>/<Unauthenticated>/<AuthLoading>. Inside Authenticated we add a
// THIRD state — "pending" — for users who signed in but are not yet approved.
// All chat queries/mutations are scoped server-side to the authenticated user
// and require an ACTIVE role, so a pending user is rejected by the backend even
// if the UI is bypassed.

export function ConvexChatApp() {
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
  // Google is the production method. "anonymous" is a DEV-ONLY provider (enabled
  // on the deployment via OPENCLAW_ENABLE_ANON_AUTH=1) so the chat can be
  // exercised locally without OAuth credentials.
  return (
    <div className="oc-signin">
      <h1 className="oc-signin__title">OpenClaw webchat</h1>
      <button
        type="button"
        className="oc-signin__btn"
        onClick={() => void signIn("google")}
      >
        Sign in with Google
      </button>
      <button
        type="button"
        className="oc-signin__btn oc-signin__btn--dev"
        onClick={() => void signIn("anonymous")}
      >
        Continue (dev, no account)
      </button>
    </div>
  );
}

// After authentication, provision the profile once (me.bootstrap — the only
// mutation a pending user may call) and route by role.
function RoleGate() {
  const me = useQuery(api.me.getMe) as Me | undefined;
  const bootstrap = useMutation(api.me.bootstrap);

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

  if (me === undefined) return <div className="oc-boot">Chargement…</div>;

  const userLabel = me.name || me.email || "Compte";

  if (me.role === "pending") {
    return (
      <div className="oc-shell">
        <header className="oc-topbar">
          <span className="oc-topbar__brand">OpenClaw</span>
          <div className="oc-topbar__actions">
            <UserMenu label={userLabel} mode={me.themeMode} />
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
    <ChatWorkspace
      isAdmin={me.role === "admin"}
      userLabel={userLabel}
      themeMode={me.themeMode}
    />
  );
}

// Global top bar: sidebar toggle (left) + brand + single user menu (right).
// Shown on every authenticated surface; the toggle stays reachable even when
// the sidebar is collapsed.
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
        <span className="oc-topbar__brand">OpenClaw</span>
      </div>
      <div className="oc-topbar__actions">
        <UserMenu label={userLabel} mode={themeMode} />
      </div>
    </header>
  );
}

function ChatWorkspace({
  isAdmin,
  userLabel,
  themeMode,
}: {
  isAdmin: boolean;
  userLabel: string;
  themeMode: ThemeMode | null;
}) {
  const [activeChatId, setActiveChatId] = useState<Id<"chats"> | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const { width, collapsed, toggleCollapsed, startResize } = useSidebarLayout();

  return (
    <div className="oc-shell">
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
            <ChatSidebar
              activeChatId={showSettings ? null : activeChatId}
              onSelect={(id) => {
                setActiveChatId(id);
                setShowSettings(false);
              }}
            />
            {isAdmin ? (
              <Button
                variant={showSettings ? "secondary" : "ghost"}
                className="m-2 justify-start"
                onClick={() => setShowSettings((s) => !s)}
              >
                <SettingsIcon /> Settings
              </Button>
            ) : null}
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
          {showSettings && isAdmin ? (
            <AdminSettings />
          ) : (
            <ConvexChat chatId={activeChatId as ConvexId<"chats"> | null} />
          )}
        </main>
      </div>
    </div>
  );
}
