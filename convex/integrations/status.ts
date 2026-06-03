// Admin-only status of the outbound trace-shipping integrations (increment 5).
//
// For a future Settings panel (no UI now). NEVER exposes secret values — only
// the `configured` booleans (derived from env presence) and the per-vendor
// cursors. Credentials live in deployment env (D3) and never cross this boundary.

import { query, QueryCtx } from "../_generated/server";
import { requireAdmin } from "../lib/access";
import { langfuseConfig, opikConfig } from "./config";

type IntegrationsStatus = {
  langfuse: { configured: boolean };
  opik: { configured: boolean };
  // L4: cursors carry secret-free failure bookkeeping so an operator can see a
  // wedged vendor (reason CODE + vendor HTTP status only — never a secret).
  cursors: Array<{
    vendor: string;
    lastAt: number;
    failureCount: number;
    lastError: string | null;
    lastErrorStatus: number | null;
  }>;
};

/**
 * Admin-only: report which vendors are configured + their shipping cursors.
 * SECRET-SAFE by construction: it reads `configured` (a boolean) from the config
 * helpers and the public cursor watermarks — never the keys/host themselves.
 */
export const status = query({
  args: {},
  handler: async (ctx: QueryCtx): Promise<IntegrationsStatus> => {
    await requireAdmin(ctx);

    const cursorRows = await ctx.db.query("integrationCursors").take(50);
    const cursors = cursorRows.map((r) => ({
      vendor: r.vendor,
      lastAt: r.lastAt,
      failureCount: r.failureCount ?? 0,
      lastError: r.lastError ?? null,
      lastErrorStatus: r.lastErrorStatus ?? null,
    }));

    return {
      langfuse: { configured: langfuseConfig().configured },
      opik: { configured: opikConfig().configured },
      cursors,
    };
  },
});
