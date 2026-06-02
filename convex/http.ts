// HTTP router. @convex-dev/auth requires its OAuth callback / sign-in routes to
// be registered here. This is standard boilerplate; project-specific logic is
// in messages.ts / send.ts / stream.ts / bridge.ts.
//
// REQUIRES A LIVE DEPLOYMENT to serve these routes.

import { httpRouter } from "convex/server";
import { auth } from "./auth";
import { ingest } from "./bridge_ingest";

const http = httpRouter();

// Registers /api/auth/* routes (OAuth start/callback, token exchange).
auth.addHttpRoutes(http);

// Bridge -> Convex ingest. The bridge worker POSTs normalized OpenClaw events
// here (Bearer BRIDGE_INGEST_SECRET) and the httpAction runs internal.stream.*.
// Served at the deployment `.site` origin.
http.route({
  path: "/bridge/ingest",
  method: "POST",
  handler: ingest,
});

export default http;
