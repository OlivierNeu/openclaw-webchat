// Bridge entrypoint: wire config -> Convex writer -> session registry -> HTTP
// server, then listen. Graceful shutdown closes every live OpenClaw socket and
// the HTTP server so there are no zombie connections.
//
// Run with: node dist/index.js   (after `npm run build`)

import { loadConfig } from "./config.js";
import { HttpConvexWriter } from "./convex-writer.js";
import { SessionRegistry } from "./session.js";
import { createBridgeServer } from "./server.js";

function main(): void {
  // Fail fast on missing/invalid env before opening any socket.
  const config = loadConfig();

  const writer = new HttpConvexWriter({
    convexHttpActionsUrl: config.convexHttpActionsUrl,
    ingestSecret: config.convexIngestSecret,
  });
  const registry = new SessionRegistry(config, writer);
  const server = createBridgeServer({ config, registry });

  server.listen(config.port, () => {
    console.log(`bridge listening on :${config.port}`);
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`received ${signal}, shutting down`);
    registry.closeAll();
    server.close(() => process.exit(0));
    // Hard cap so a stuck close never blocks the process forever.
    const timer = setTimeout(() => process.exit(0), 5_000);
    if (typeof timer.unref === "function") {
      timer.unref();
    }
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main();
