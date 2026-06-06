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

    // RBAC role (Open WebUI style). OPTIONAL so adding this field does not
    // reject pre-existing role-less rows on schema push; the single role-writer
    // (lib/access.ensureProfile) backfills it. Semantics:
    //   - "pending": authenticated but NOT yet approved -> blocked from the app
    //   - "user":    approved, full chat access
    //   - "admin":   approved + can manage users/roles/groups/instances
    // A row with no role is treated as "pending" by the access helpers.
    role: v.optional(
      v.union(v.literal("pending"), v.literal("user"), v.literal("admin")),
    ),
    // Display fields (non-secret) for the admin user list.
    email: v.optional(v.string()),
    name: v.optional(v.string()),

    // Per-user theme preference (identity-level: even a pending user controls
    // it). OPTIONAL: when unset, the resolver falls back to the admin default,
    // then "system". `themeName` is reserved for future named palettes.
    themeMode: v.optional(
      v.union(v.literal("light"), v.literal("dark"), v.literal("system")),
    ),
    themeName: v.optional(v.string()),

    // Per-user chat preference: show OpenClaw tool-execution cards in the thread.
    // Toggled from the chat surface. OPTIONAL (additive); absent => shown (true).
    showTools: v.optional(v.boolean()),

    // Per-user preference: surface the voice-input (mic) button in the composer.
    // OPTIONAL (additive); absent => OFF (the mic is hidden by default — the
    // talk.* voice pipeline is not wired yet, so the control only appears when a
    // user explicitly opts in). Feature-flag for the composer mic.
    voiceInput: v.optional(v.boolean()),

    // --- Routing (valves) ---------------------------------------------------
    // Group membership drives routing by default (see `groups`). A per-user
    // OVERRIDE wins over the group when set.
    groupId: v.optional(v.id("groups")),
    // Per-user override of the resolved OpenClaw target. Non-secret names only.
    overrideInstance: v.optional(v.string()), // -> instances.name
    overrideAgentId: v.optional(v.string()),
    // Stable per-user key used to derive a per-user agent / session namespace
    // (OpenClaw `canonical`). Defaults to a slug of the email when unset.
    canonical: v.optional(v.string()),
    // Chat-id prefixes this user is allowed to address on the gateway.
    allowedChatPrefixes: v.optional(v.array(v.string())),

    // Admin impersonation target. When an admin starts "view/act as a user",
    // the target's userId is recorded HERE, on the ADMIN's own profile. The
    // access layer resolves the EFFECTIVE user from it (real admin identity +
    // this target); cleared on stop. ONLY honored when this profile's role is
    // "admin" (a non-admin row carrying it would be ignored), so it can never
    // be used to escalate. OPTIONAL (additive on existing rows).
    impersonatingUserId: v.optional(v.id("users")),
  })
    .index("by_user", ["userId"])
    .index("by_role", ["role"]),

  // A routing group (valve). Members of a group share an OpenClaw instance and
  // a routing MODE:
  //   - "per-user": each member gets their OWN agent, derived from their
  //                 `canonical` (e.g. agentId = canonical). Isolation per user.
  //   - "shared":   every member talks to the SAME agent (`sharedAgentId`).
  // NO secrets — only the non-secret instance NAME the bridge maps to a token.
  groups: defineTable({
    name: v.string(),
    instanceName: v.string(), // -> instances.name
    mode: v.union(v.literal("per-user"), v.literal("shared")),
    sharedAgentId: v.optional(v.string()), // required when mode === "shared"
    description: v.optional(v.string()),
  }).index("by_name", ["name"]),

  // OpenClaw instances the deployment knows about. NO secrets (gateway tokens
  // and device identities are bridge-env only — the bridge maps `name` -> token).
  instances: defineTable({
    name: v.string(),
    gatewayUrl: v.string(),
    displayName: v.optional(v.string()),
  }).index("by_name", ["name"]),

  // Singleton app metadata. Exactly one row (key === "singleton"). Acts as the
  // serialization point for first-admin bootstrap: the first sign-in that finds
  // `adminAssigned === false` claims admin AND flips the flag in one
  // transaction; concurrent first sign-ins collide on THIS doc (OCC) and the
  // loser retries, sees the flag set, and becomes "pending".
  appMeta: defineTable({
    key: v.string(),
    adminAssigned: v.boolean(),
    // Global toggle reserved for future "require admin approval" policy; the
    // pending->user approval flow is always on for now.
    requireApproval: v.optional(v.boolean()),
    // Admin-defined default theme mode, used when a user has no preference.
    // OPTIONAL: when unset, the resolver falls back to "system". `defaultThemeName`
    // is reserved for future named palettes.
    defaultThemeMode: v.optional(
      v.union(v.literal("light"), v.literal("dark"), v.literal("system")),
    ),
    defaultThemeName: v.optional(v.string()),
  }).index("by_key", ["key"]),

  // Append-only audit trail for cross-identity (impersonation) actions. Records
  // WHO really acted (`realUserId` = the admin) and AS WHOM (`effectiveUserId` =
  // the impersonated target), so every create / delete / send performed "in
  // place of" a user is attributable to the real operator — the traceability
  // requirement for the impersonation module. This is a NEW table (no existing
  // rows) so its fields are required. NEVER stores message content or other PHI:
  // only the action verb + the resource kind/id that was touched.
  auditLog: defineTable({
    at: v.number(),
    action: v.string(), // e.g. "chat.create", "chat.delete", "impersonation.start"
    realUserId: v.id("users"), // the actual signed-in operator
    effectiveUserId: v.id("users"), // the identity the action ran as
    impersonated: v.boolean(), // realUserId !== effectiveUserId
    resource: v.optional(v.string()), // resource kind, e.g. "chat", "project", "message"
    resourceId: v.optional(v.string()),
  })
    .index("by_time", ["at"])
    .index("by_real", ["realUserId"]),

  // A user's project: a named grouping of chats in the sidebar. Per-user.
  projects: defineTable({
    userId: v.id("users"),
    name: v.string(),
    sortKey: v.optional(v.number()), // fractional order key
    color: v.optional(v.string()), // preset token name
    collapsed: v.optional(v.boolean()),
  }).index("by_user", ["userId"]),

  // A chat thread owned by exactly one user.
  chats: defineTable({
    userId: v.id("users"),
    title: v.optional(v.string()),
    // The OpenClaw-side chat identifier (used to route sends). Non-secret.
    openclawChatId: v.optional(v.string()),
    archived: v.optional(v.boolean()),
    updatedAt: v.number(),
    // Sidebar organization (all optional — additive on existing rows):
    projectId: v.optional(v.id("projects")), // 0-or-1 project membership
    sortKey: v.optional(v.number()), // fractional manual order (lower = higher)
    pinned: v.optional(v.boolean()), // pinned chats sort above unpinned
    color: v.optional(v.string()), // preset token name, list display only
    // OpenClaw session meta, mirrored from the gateway's self-describing
    // `sessions.describe({ key })` so the chat header can surface the model,
    // reasoning (thinking) level, verbosity, and the context-usage meter without
    // the frontend hardcoding any enum. The bridge refreshes this per turn; it is
    // READ-ONLY here (write-back via a later `sessions.patch` increment). Fully
    // OPTIONAL + every inner field optional → additive on existing rows AND
    // forward-compatible (a new thinking level / model surfaces with no schema
    // change). NEVER holds secrets — model/level names are non-sensitive.
    sessionMeta: v.optional(
      v.object({
        model: v.optional(v.string()), // e.g. "gpt-5.5"
        modelProvider: v.optional(v.string()), // e.g. "openai-codex"
        agentRuntime: v.optional(v.string()), // e.g. "codex"
        thinkingLevel: v.optional(v.string()), // current effective level
        thinkingDefault: v.optional(v.string()), // agent default (inheritance src)
        thinkingLevels: v.optional(
          v.array(v.object({ id: v.string(), label: v.string() })),
        ),
        // Available models for the write-back picker, mirrored once from the
        // gateway's `models.list` (deduped by id). Non-secret labels only.
        availableModels: v.optional(
          v.array(v.object({ id: v.string(), label: v.string() })),
        ),
        verboseLevel: v.optional(v.string()), // e.g. "full"
        totalTokens: v.optional(v.number()), // used context tokens
        contextTokens: v.optional(v.number()), // context window size
        estimatedCostUsd: v.optional(v.number()),
        updatedAt: v.optional(v.number()),
      }),
    ),
    // User-chosen per-chat OpenClaw overrides (write-back via `sessions.patch`).
    // INTENT, distinct from `sessionMeta` (the gateway's confirmed live TRUTH):
    // the bridge applies these immediately when changed AND re-applies them
    // before each turn so they survive a session reset/roll. Optional + additive
    // + every inner field optional → forward-compatible. NEVER holds secrets.
    sessionSettings: v.optional(
      v.object({
        thinkingLevel: v.optional(v.string()), // reasoning level id
        model: v.optional(v.string()), // model id
      }),
    ),
  })
    .index("by_user", ["userId"])
    .index("by_project", ["projectId"]),

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
    // A2 streaming (decision A2): during a turn, token deltas are patched into
    // this UN-INDEXED live field — NOT into `text` — so each ~50ms flush does NOT
    // re-index the search index (the per-flush reindex amplifier). At finalize the
    // authoritative text is written ONCE into the searchable `text` and `liveText`
    // is cleared. `listByChat` returns `liveText` while streaming, `text` when done,
    // so the browser streams token-by-token with no frontend change and `text`
    // stays the single searchable/durable copy. OPTIONAL (additive on existing rows).
    liveText: v.optional(v.string()),
    error: v.optional(v.string()),
    updatedAt: v.number(),
  })
    .index("by_chat", ["chatId"])
    // Full-text search over message bodies for the global conversation search
    // (topbar palette). `userId` is a filter field so a single index serves the
    // owner-scoped query directly: q.search("text", term).eq("userId", userId).
    // This is THE access boundary for message hits — never search without it.
    // Note: `text` is patched in place during streaming, so this index re-indexes
    // on each token patch; acceptable at our scale (metadata-only platform).
    .searchIndex("search_text", {
      searchField: "text",
      filterFields: ["userId"],
    }),

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
    // Inbound attachments WITH the browser-supplied filename + mimeType (the
    // dispatch needs both to build OpenClaw's chat.send.attachment shape — the
    // storageId alone loses them). Optional/additive: legacy rows only have
    // `attachmentIds`. The dispatch resolves storageId -> bytes -> base64.
    attachments: v.optional(
      v.array(
        v.object({
          storageId: v.id("_storage"),
          filename: v.string(),
          mimeType: v.string(),
        }),
      ),
    ),
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
    .index("by_client_message", ["userId", "clientMessageId"])
    // Reverse lookup message -> outbox row, used by forensic feedback to capture
    // the dispatched payload best-effort (the row is transient, may be gone).
    .index("by_message", ["messageId"]),

  // On-demand FORENSIC feedback (OpenRouter-style "Report Feedback"). When a user
  // flags a message (category + comment), we FREEZE a full forensic snapshot at
  // that instant — so a later UI-7 delete/regenerate cannot erase the disputed
  // evidence, and an admin can analyze "did the system alter words?" with the
  // complete context. NEW table -> required fields are fine.
  //
  // Trust model (see convex/feedback.ts):
  //   - Everything under `snapshot` EXCEPT `displayedText`/`clientInfo` is
  //     SERVER-READ from the DB inside the mutation — never accepted from the
  //     client (else the forensic proof would be forgeable).
  //   - `displayedText` is the ONLY client-declared content: it is what the
  //     BROWSER actually rendered (the byte-exact `.oc-msg__source-pre`
  //     textContent / `rawText`), captured solely so the server can compare it to
  //     the stored text (`displayedMatchesStored`) and prove browser fidelity.
  //   - `realUserId`/`impersonated` give accountability when an admin reports
  //     while impersonating. Reading feedback content back is an admin path that
  //     must be audited + gated by `traces.read.content` (increment B).
  feedback: defineTable({
    userId: v.id("users"), // effective reporter
    realUserId: v.id("users"), // who really clicked (impersonation-aware)
    impersonated: v.boolean(),
    chatId: v.id("chats"),
    messageId: v.id("messages"),
    at: v.number(),
    category: v.string(), // incoherence|incorrect|altered_words|formatting|latency|api_error|other
    comment: v.optional(v.string()),
    snapshot: v.object({
      // --- The reported message (SERVER-READ, authoritative) ---
      messageRole: v.string(),
      messageText: v.string(),
      messageStatus: v.optional(v.string()),
      messageError: v.optional(v.string()),
      messageUpdatedAt: v.optional(v.number()),
      runId: v.optional(v.string()),
      isRegeneration: v.optional(v.boolean()), // derived from a regen-* outbox key
      partsJson: v.optional(v.string()), // serialized messageParts (tools/reasoning/media)
      partsCount: v.optional(v.number()),
      // --- Generating context (SERVER-READ) ---
      promptMessageId: v.optional(v.id("messages")),
      promptText: v.optional(v.string()), // immediately preceding user turn
      contextJson: v.optional(v.string()), // bounded [{role,text}] window, oldest->newest
      contextCount: v.optional(v.number()),
      contextWindowLimit: v.optional(v.number()), // the bound applied (no silent truncation)
      contextTruncated: v.optional(v.boolean()),
      // --- Session config that produced it (SERVER-READ) ---
      sessionSettings: v.optional(
        v.object({
          thinkingLevel: v.optional(v.string()),
          model: v.optional(v.string()),
        }),
      ),
      sessionMetaJson: v.optional(v.string()), // full sessionMeta at report time
      openclawModel: v.optional(v.string()),
      openclawProvider: v.optional(v.string()),
      openclawRuntime: v.optional(v.string()),
      openclawVersion: v.optional(v.string()), // bridge-side; may be absent in Convex
      // --- What was dispatched (SERVER-READ, best-effort; outbox is transient) ---
      outboxText: v.optional(v.string()),
      outboxStatus: v.optional(v.string()),
      outboxClientMessageId: v.optional(v.string()),
      outboxAttachmentsCount: v.optional(v.number()),
      outboxAvailable: v.optional(v.boolean()),
      // --- Integrity (optional; snapshot itself is already the frozen proof) ---
      contentHash: v.optional(v.string()),
      // --- CLIENT DECLARATIONS (browser-fidelity comparison ONLY, not trusted) ---
      displayedText: v.optional(v.string()),
      displayedMatchesStored: v.optional(v.boolean()), // server: displayedText === messageText
      clientInfo: v.optional(
        v.object({
          userAgent: v.optional(v.string()),
          language: v.optional(v.string()),
          timezone: v.optional(v.string()),
          appVersion: v.optional(v.string()),
          theme: v.optional(v.string()),
          sourceWasOpen: v.optional(v.boolean()),
        }),
      ),
    }),
  })
    .index("by_chat", ["chatId"])
    .index("by_message", ["messageId"])
    .index("by_time", ["at"])
    .index("by_real", ["realUserId"]),

  // ===========================================================================
  // Observability & RBAC spine (increment 1). All NEW tables -> required fields
  // are fine (no pre-existing rows to reject on schema push). See
  // docs/OBSERVABILITY_PLATFORM_PLAN.md "Schema additions".
  // ===========================================================================

  // RBAC roles. Built-in roles (pending|user|admin|observer|agent) are seeded
  // from lib/rbac.BUILTIN_ROLES; custom roles are added via the admin matrix.
  // `permissions` is a bounded list of permission-key strings; the wildcard
  // "*" (admin) means "all permissions" and is expanded by roleHasPermission.
  // This is the role->permission source of truth; lib/access keeps owning the
  // profiles.role validator (pending|user|admin) for THIS increment.
  roles: defineTable({
    key: v.string(), // stable identifier, e.g. "admin", "observer"
    name: v.string(), // human label
    description: v.optional(v.string()),
    builtin: v.boolean(), // seeded by seedBuiltinRoles (not user-deletable)
    permissions: v.array(v.string()), // permission keys, or ["*"] for all
  }).index("by_key", ["key"]),

  // A non-human principal (an OpenClaw agent / external service) that holds one
  // or more API keys. Its `roleKey` resolves to a role -> permission set at
  // auth time. NO secrets here (keys live hashed in `apiKeys`). Created/managed
  // by admin-only Convex functions (D4: never via the /api/v1 HTTP surface).
  serviceAccounts: defineTable({
    name: v.string(),
    roleKey: v.string(), // -> roles.key (e.g. "observer", "agent")
    disabled: v.boolean(),
    description: v.optional(v.string()),
    createdByUserId: v.id("users"), // admin who created it (attribution)
  }).index("by_name", ["name"]),

  // API keys for service accounts. SECRET-SAFE: only the SHA-256 hash of the
  // plaintext key is stored (`hashedKey`); the plaintext (`oc_live_<base62>`)
  // is shown exactly ONCE at mint time and never persisted. `prefix`/`lastFour`
  // are non-secret display affordances for the keys list. Verification hashes
  // the presented Bearer token and looks it up via `by_hash`.
  apiKeys: defineTable({
    serviceAccountId: v.id("serviceAccounts"),
    hashedKey: v.string(), // SHA-256 hex of the plaintext (the only stored form)
    prefix: v.string(), // non-secret leading segment, e.g. "oc_live_AB12"
    lastFour: v.string(), // non-secret trailing 4 chars for disambiguation
    disabled: v.boolean(), // revoked keys are disabled, not deleted (audit)
    createdAt: v.number(),
    lastUsedAt: v.optional(v.number()),
    expiresAt: v.optional(v.number()),
  })
    .index("by_hash", ["hashedKey"]) // O(1) verification lookup
    .index("by_account", ["serviceAccountId"]), // list/revoke a SA's keys

  // Bounded recent trace window (D1). Convex is NOT the log store: a daily cron
  // (observability.purgeOldTraces) deletes rows older than TRACE_RETENTION_DAYS.
  // D2 PHI: metadata only by default (route/method/status/latency/principal) —
  // never raw message text. `redacted` records whether content was stripped.
  // `meta` is a JSON string blob for forward-compatible, non-PHI extras.
  traceEvents: defineTable({
    at: v.number(),
    kind: v.string(), // e.g. "api.call"
    direction: v.optional(
      v.union(
        v.literal("inbound"),
        v.literal("outbound"),
        v.literal("internal"),
      ),
    ),
    principalType: v.union(
      v.literal("user"),
      v.literal("service"),
      v.literal("system"),
    ),
    principalId: v.optional(v.string()),
    roleKey: v.optional(v.string()),
    route: v.optional(v.string()),
    method: v.optional(v.string()),
    status: v.optional(v.number()),
    latencyMs: v.optional(v.number()),
    chatId: v.optional(v.string()),
    runId: v.optional(v.string()),
    correlationId: v.optional(v.string()),
    redacted: v.boolean(),
    meta: v.optional(v.string()), // JSON-encoded non-PHI extras
  })
    .index("by_at", ["at"]) // retention scan + recent-events listing
    .index("by_correlation", ["correlationId"]) // follow a span chain
    .index("by_principal", ["principalType", "principalId"]),

  // Small, aggregated, long-lived KPI rollups (D1). STUB for increment 1 — the
  // cron aggregation bodies land in increment 4. Defined now so the schema/
  // index are stable for downstream agents.
  kpiRollups: defineTable({
    bucket: v.string(), // e.g. "2026-06-02T14" (hour granularity)
    metric: v.string(),
    value: v.number(),
    dims: v.optional(v.string()), // JSON-encoded dimension breakdown
  }).index("by_bucket_metric", ["bucket", "metric"]),

  // Detected / reported anomalies (increment 6). Two sources:
  //   - "detector": rows UPSERTED by the `anomalies.detectAnomalies` cron from
  //     the bounded recent `traceEvents` window (high API error ratio, repeated
  //     dispatch failures, assistant.stream error/aborted bursts, ingest
  //     auth-denied spikes). De-duped to ONE OPEN row per `kind` (the cron
  //     patches the existing open row instead of inserting a duplicate each run).
  //   - "agent": rows inserted via the key-authed `POST /api/v1/anomalies` route
  //     so an OpenClaw agent can report an anomaly OR a self-repair action taken.
  // D2 PHI: METADATA ONLY. `evidence` is a JSON string of NON-PHI signals
  // (counts/ratios/thresholds/window) — never message text, tokens, or paths.
  anomalies: defineTable({
    at: v.number(), // first-seen (insert) / last-seen (patch) timestamp
    kind: v.string(), // stable detector key, e.g. "api.error_ratio"
    severity: v.union(
      v.literal("info"),
      v.literal("warn"),
      v.literal("critical"),
    ),
    status: v.union(
      v.literal("open"),
      v.literal("acknowledged"),
      v.literal("resolved"),
    ),
    message: v.string(), // human-readable, non-PHI summary
    source: v.union(v.literal("detector"), v.literal("agent")),
    correlationId: v.optional(v.string()), // optional link to a span chain
    evidence: v.optional(v.string()), // JSON-encoded non-PHI signals
    resolvedAt: v.optional(v.number()),
    resolvedBy: v.optional(v.string()), // principal/actor id (non-PHI), free-form
  })
    .index("by_status", ["status"]) // dedupe scan (open rows) + listing filter
    .index("by_at", ["at"]) // recent-first listing
    // (status, kind) — look up THE single open detector row of a kind directly
    // so de-dupe (upsertDetectorAnomaly) + auto-resolve are correct regardless
    // of how large the open set grows (no .take(500) truncation hazard).
    .index("by_status_kind", ["status", "kind"]),

  // Outbound trace-shipping cursors (increment 5). One row per vendor
  // ("langfuse"/"opik"): `lastAt` is the `traceEvents.at` watermark up to and
  // INCLUDING which that vendor has already received events. The periodic flush
  // (integrations.ship.flushToVendors) reads `traceEvents` with the COMPOSITE
  // watermark (at, _id), ships a bounded batch, then advances both ON SUCCESS
  // only. No secrets here — vendor credentials live in deployment env (D3); this
  // table holds only the watermark + secret-free failure bookkeeping.
  integrationCursors: defineTable({
    vendor: v.string(), // "langfuse" | "opik"
    lastAt: v.number(), // last shipped traceEvents.at (watermark)
    // M3: secondary tiebreaker so a same-millisecond batch boundary cannot drop
    // events. Paging is (at > lastAt) OR (at == lastAt AND _id > lastId).
    // OPTIONAL (additive on existing rows); absent => fall back to strict-gt.
    lastId: v.optional(v.string()), // last shipped traceEvents _id (as string)
    // L4: secret-free consecutive-failure bookkeeping for a wedged vendor. Reset
    // to 0 on a successful send; emits an anomaly once at the threshold. NEVER a
    // raw error message — only a reason CODE + optional vendor HTTP status.
    failureCount: v.optional(v.number()),
    lastError: v.optional(v.string()), // reason code (e.g. "send_failed") only
    lastErrorStatus: v.optional(v.number()), // vendor HTTP status when present
  }).index("by_vendor", ["vendor"]),
});
