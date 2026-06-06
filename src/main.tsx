import React from "react";
import ReactDOM from "react-dom/client";
import { ConvexReactClient } from "convex/react";
import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { RouterProvider } from "@tanstack/react-router";
import { router } from "./router";
import { DialogsProvider } from "@/components/ConfirmDialog";
import { FeedbackProvider } from "./chat/FeedbackDialog";
import "./index.css";
import "./chat/convexChat.css";

// Router devtools, dev-only and lazy (import.meta.env.DEV is statically false in
// a production build, so the devtools package is tree-shaken out of the bundle).
const RouterDevtools = import.meta.env.DEV
  ? React.lazy(() =>
      import("@tanstack/react-router-devtools").then((m) => ({
        default: m.TanStackRouterDevtools,
      })),
    )
  : () => null;

// Convex local (anonymous) for now; NAS self-hosted later. URL from .env.local.
//
// This app wires @convex-dev/auth (see convex/auth.ts + convex/schema.ts's
// ...authTables). Per the Convex auth guidelines, a client for an auth-enabled
// deployment MUST use ConvexAuthProvider (the @convex-dev/auth wrapper around
// ConvexProviderWithAuth). With a plain <ConvexProvider>, ctx.auth has no token
// source, so ctx.auth.getUserIdentity() returns null on the server and every
// requireUserId()/getAuthUserId() throws "Unauthorized" — the whole chat surface
// (chats, messages, send, uploads) is gated behind that identity.
//
// Provider composition (docs/ROUTING_RESEARCH.md §2): ConvexAuthProvider stays
// the OUTERMOST provider (its token source is mandatory); RouterProvider nests
// inside it; DialogsProvider (the app-wide confirm/prompt modals) wraps the
// router so any route can call useConfirm/usePrompt. The single
// ConvexReactClient is created once → the WebSocket persists across client-side
// navigations (no reconnection thrash).
const convex = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL as string);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ConvexAuthProvider client={convex}>
      <DialogsProvider>
        <FeedbackProvider>
          <RouterProvider router={router} />
        </FeedbackProvider>
        <React.Suspense fallback={null}>
          {/* Dev-only. Toggle button bottom-RIGHT so it doesn't overlap the
              sidebar's Settings button (default is bottom-left). */}
          <RouterDevtools router={router} position="bottom-right" />
        </React.Suspense>
      </DialogsProvider>
    </ConvexAuthProvider>
  </React.StrictMode>,
);
