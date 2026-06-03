/// <reference types="vitest/config" />
import { defineConfig } from "vitest/config";

// convex-test runs Convex functions in-process against an in-memory backend.
// It requires the edge-runtime environment (Web APIs like crypto.subtle, which
// our API-key hashing depends on) and convex-test inlined so its ESM is
// transformed. See convex/_generated/ai/guidelines.md "Testing guidelines".
export default defineConfig({
  test: {
    environment: "edge-runtime",
    server: {
      deps: {
        inline: ["convex-test"],
      },
    },
    // Only pick up Convex unit tests; the app's own (browser) code is built/
    // typechecked separately.
    include: ["convex/**/*.test.ts"],
  },
});
