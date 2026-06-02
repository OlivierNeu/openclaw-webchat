// Convex schema for the OpenClaw WebChat bridge.
//
// Design invariants (load-bearing):
//   - Convex stores ONLY non-secret metadata. Gateway tokens, device
//     identities, Convex deploy/service keys and OpenClaw filesystem paths
//     NEVER live in any table here.
//   - Reactivity is driven entirely by this DB: the bridge writes normalized
//     events into `messages` / `messageParts` and assistant-ui re-renders.
//   - Per-user access control is enforced in functions (queries/mutations),
//     not by the schema; the indexes below exist so those scoped queries are
//     cheap (e.g. `by_user`, `by_chat`).

import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { authTables } from "@convex-dev/auth/server";

// A single normalized message part. assistant-ui's `convertMessage` maps these
// onto ThreadMessageLike content parts:
//   - tool      -> { type: "tool-call", toolName, args, result }
//   - media     -> { type: "file"/"image", mimeType, data: <storage url> }
//   - file      -> { type: "file", mimeType, data: <storage url> }
//   - reasoning -> { type: "reasoning", text }
export const messagePart = v.union(
  v.object({
    kind: v.literal("tool"),
    name: v.string(),
    // Lifecycle phase emitted by the normalizer (e.g. "start", "running",
    // "done"). Free-form string to stay forward-compatible with OpenClaw.
    phase: v.string(),
    input: v.optional(v.any()),
    output: v.optional(v.any()),
  }),
  v.object({
    kind: v.literal("media"),
    storageId: v.id("_storage"),
    filename: v.string(),
    mimeType: v.string(),
  }),
  v.object({
    kind: v.literal("file"),
    storageId: v.id("_storage"),
    filename: v.string(),
    mimeType: v.string(),
  }),
  v.object({
    kind: v.literal("reasoning"),
    text: v.string(),
  }),
);

export default defineSchema({
  // @convex-dev/auth's own tables (authAccounts, authSessions, authRefreshTokens,
  // authVerificationCodes, ... AND its own `users` table). Spreading this is
  // MANDATORY: without it the auth flow has nowhere to persist accounts/sessions.
  // We intentionally do NOT redefine `users` ourselves — authTables owns it, and
  // `getAuthUserId(ctx)` returns an Id<"users"> from this table. Our extra
  // project fields live in `profiles` (1:1 with a users row) so we never collide
  // with the columns @convex-dev/auth writes.
  ...authTables,

  // Project-specific, non-secret profile data for an authenticated user. Keyed
  // 1:1 to the authTables `users` row via `userId` (the value getAuthUserId
  // returns). NO secrets (gateway URL lives in `instances`, tokens in bridge).
  profiles: defineTable({
    userId: v.id("users"), // -> authTables users (getAuthUserId result)
    // Which OpenClaw instance / agent this user is routed to. Non-secret.
    openclawInstance: v.optional(v.string()),
    agentId: v.optional(v.string()),
    // Whether this user is the canonical/primary operator session.
    canonical: v.optional(v.boolean()),
    // Chat-id prefixes this user is allowed to address on the gateway.
    allowedChatPrefixes: v.optional(v.array(v.string())),
  }).index("by_user", ["userId"]),

  // OpenClaw instances the deployment knows about. NO secrets (gateway tokens
  // and device identities are bridge-env only).
  instances: defineTable({
    name: v.string(),
    gatewayUrl: v.string(),
    displayName: v.optional(v.string()),
  }),

  // A chat thread owned by exactly one user.
  chats: defineTable({
    userId: v.id("users"),
    title: v.optional(v.string()),
    // The OpenClaw-side chat identifier (used to route sends). Non-secret.
    openclawChatId: v.optional(v.string()),
    archived: v.optional(v.boolean()),
    updatedAt: v.number(),
  }).index("by_user", ["userId"]),

  // Individual messages within a chat. Streaming assistant text is patched in
  // place on `text` (reactivity -> assistant-ui re-render).
  messages: defineTable({
    chatId: v.id("chats"),
    userId: v.id("users"), // owner (denormalized for cheap access checks)
    role: v.union(
      v.literal("user"),
      v.literal("assistant"),
      v.literal("system"),
    ),
    runId: v.optional(v.string()), // OpenClaw runId for assistant turns
    status: v.union(
      v.literal("streaming"),
      v.literal("complete"),
      v.literal("error"),
      v.literal("aborted"),
    ),
    text: v.string(),
    error: v.optional(v.string()),
    updatedAt: v.number(),
  }).index("by_chat", ["chatId"]),

  // Structured non-text content attached to a message, ordered for rendering.
  messageParts: defineTable({
    messageId: v.id("messages"),
    order: v.number(),
    part: messagePart,
  }).index("by_message", ["messageId"]),

  // Ownership record for browser-uploaded storage blobs. There is no
  // server-side "upload completed" hook in Convex: `generateUploadUrl` returns
  // the signed URL BEFORE any storageId exists (the storageId only comes back
  // from the client's POST). So ownership is recorded register-at-confirm: the
  // attachment adapter calls `uploads.registerUpload({ storageId })` right
  // after the POST resolves, deriving the user via auth. `send.sendMessage`
  // then enforces IDOR by rejecting any attachment storageId not registered to
  // the calling user. NO secrets — just an opaque storage id keyed to a user.
  uploads: defineTable({
    storageId: v.id("_storage"),
    userId: v.id("users"),
  })
    // Single indexed lookup for the IDOR gate: (userId, storageId).
    .index("by_user_storage", ["userId", "storageId"])
    // Reverse lookup (e.g. GC / audit by blob).
    .index("by_storage", ["storageId"]),

  // Queue of outbound user messages awaiting dispatch to OpenClaw via the
  // bridge. `attachmentIds` reference Convex storage blobs uploaded by the
  // browser. The bridge is the only consumer that resolves these to the
  // gateway; the browser never sees gateway/filesystem details.
  //
  // Idempotency: a retried `sendMessage` (same `clientMessageId` from the same
  // user) MUST NOT double-insert the user message nor double-dispatch. The
  // `by_client_message` index lets `sendMessage` short-circuit on an existing
  // row; `messageId` is stored so the retry can return the original message id.
  outbox: defineTable({
    chatId: v.id("chats"),
    userId: v.id("users"),
    clientMessageId: v.string(),
    // The optimistic user message this outbox row was created for. Stored so a
    // deduped retry can return the original { messageId, outboxId } pair.
    messageId: v.optional(v.id("messages")),
    text: v.string(),
    attachmentIds: v.array(v.id("_storage")),
    status: v.union(
      v.literal("pending"),
      v.literal("sent"),
      v.literal("failed"),
    ),
  })
    .index("by_status", ["status"])
    // Idempotency key scoped per user. (userId, clientMessageId) is effectively
    // unique because clientMessageId is a client-generated UUID; scoping by
    // userId keeps one user's id space from colliding with another's.
    .index("by_client_message", ["userId", "clientMessageId"]),
});
