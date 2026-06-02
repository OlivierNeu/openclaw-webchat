import React from "react";
import ReactDOM from "react-dom/client";
import { ConvexReactClient } from "convex/react";
import { ConvexAuthProvider } from "@convex-dev/auth/react";
import App from "./App";
import "./index.css";

// Convex local (anonymous) for now; NAS self-hosted later. URL from .env.local.
//
// This app wires @convex-dev/auth (see convex/auth.ts + convex/schema.ts's
// ...authTables). Per the Convex auth guidelines, a client for an auth-enabled
// deployment MUST use ConvexAuthProvider (the @convex-dev/auth wrapper around
// ConvexProviderWithAuth). With a plain <ConvexProvider>, ctx.auth has no token
// source, so ctx.auth.getUserIdentity() returns null on the server and every
// requireUserId()/getAuthUserId() throws "Unauthorized" — the whole chat surface
// (chats, messages, send, uploads) is gated behind that identity.
const convex = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL as string);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ConvexAuthProvider client={convex}>
      <App />
    </ConvexAuthProvider>
  </React.StrictMode>,
);
