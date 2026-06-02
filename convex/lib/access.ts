// Per-user access-control helpers shared by the public query/mutation surface.
//
// Every PUBLIC function (callable from the browser) MUST resolve the
// authenticated user and verify ownership of any chat/message it touches.
// Internal functions (called by the bridge with a service key) do NOT go
// through here — they are not exposed to browsers.
//
// Identity model (load-bearing):
//   - @convex-dev/auth owns the `users` table (spread via `...authTables` in
//     schema.ts). `getAuthUserId(ctx)` returns the stable Id<"users"> for the
//     current request — the SAME id across sessions for one user, which is why
//     we use it instead of keying on the raw JWT `subject` (subject is
//     "<userId>|<sessionId>" and would yield a new row per session).
//   - That `users` id is the value we store as `userId` on chats / messages /
//     outbox / profiles, so ownership checks are a direct id comparison.
//   - Our project-specific non-secret fields live in `profiles` (1:1 with a
//     users row). They are NOT needed for access control.

import { getAuthUserId } from "@convex-dev/auth/server";
import { Id } from "../_generated/dataModel";
import { MutationCtx, QueryCtx } from "../_generated/server";

/**
 * Resolve the authenticated user id (an Id<"users"> from authTables) or throw.
 * Use this for ownership checks: it is the foreign key stored on chats etc.
 */
export async function requireUserId(
  ctx: QueryCtx | MutationCtx,
): Promise<Id<"users">> {
  const userId = await getAuthUserId(ctx);
  if (userId === null) {
    throw new Error("Unauthorized: authentication required");
  }
  return userId;
}

/**
 * Load a chat and assert the given user owns it. Throws otherwise.
 */
export async function requireOwnedChat(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
  chatId: Id<"chats">,
) {
  const chat = await ctx.db.get(chatId);
  if (chat === null) {
    throw new Error("Not found: chat does not exist");
  }
  if (chat.userId !== userId) {
    // Do not leak existence — explicit forbidden error for server-side audit.
    throw new Error("Forbidden: chat not owned by user");
  }
  return chat;
}

/**
 * Ensure a `profiles` row exists for the authenticated user (MUTATIONS only,
 * since it may insert). Returns the user id. Profiles hold non-secret routing
 * metadata; access control does not depend on them, so callers that only need
 * the id can use `requireUserId` instead.
 */
export async function ensureProfile(ctx: MutationCtx): Promise<Id<"users">> {
  const userId = await requireUserId(ctx);
  const existing = await ctx.db
    .query("profiles")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();
  if (existing === null) {
    await ctx.db.insert("profiles", { userId });
  }
  return userId;
}
