# Backend (Convex) design — A2 token streaming, inbound/outbound media, history reconciliation

Scope: the **Convex backend** changes only. The browser transport stays Convex
(`useQuery`); the bridge stays the trusted demux. This document specifies the
exact `convex/*` files/functions to add or change, the schema deltas (all
optional on existing tables), and the invariants each change preserves.

Anchors (do not duplicate): `PROJECT_STATE.md` (openclaw-notes, private; A2 confirmed; the three
amplifiers to kill), `docs/BRIDGE_ARCHITECTURE.md` §4 (the streaming seam + the
outbound-media fix), `docs/AISDK_VS_A2_DECISION.md` (keep A2 + assistant-ui).

### Relationship to BRIDGE_ARCHITECTURE §4 / `live-hub`

§4.2–4.8 sketches an OPTIONAL second, non-Convex browser transport
(`live-hub.ts`, a persistent bridge→browser WebSocket) purely for sub-50ms token
fluidity. This document realizes the **A2** decision — *Convex is the sole
browser transport* — natively in Convex. `live-hub`, if ever built, is a pure
fluidity add-on that sits **beside** this design (it persists nothing and is not
required by it). PROJECT_STATE (2026-06-04, the authoritative current-state doc)
supersedes §4 (2026-06-03) where they differ: A2 is the transport, no SSE/WS
per-turn.

---

## Part 1 — A2 token streaming (the un-indexed live field as a sibling row)

### 1.1 Why a sibling row, not a field on `messages`

A Convex reactive query re-runs whenever **any document it read changes** (Convex
reactivity is read-set / document based). `messages.listByChat`
(`convex/messages.ts:39-121`) reads the 200-message window **and** every
message's `messageParts` and resolves each media/file `storageId` to a signed URL
via `ctx.storage.getUrl`. If a streaming delta patched a field on the **message
row**, every ~50ms flush would invalidate `listByChat` → re-run the whole window
+ the per-message part fan-out + the per-part `getUrl` calls. That is exactly the
**"`listByChat` recompute" amplifier** PROJECT_STATE tells us to kill, and a
field-on-`messages` design **cannot** kill it (the query reads the message doc).

Therefore the live text lives in a **dedicated sibling table** that `listByChat`
does **not** read, behind a **narrow** query the client subscribes to separately.
A pure text delta then touches exactly one cheap row and invalidates exactly one
cheap query.

The three PROJECT_STATE amplifiers, addressed separately:
- **(a) search-index reindex** — killed by writing `messages.text` (the
  `searchIndex("search_text", { searchField: "text" })`, `schema.ts:228-231`)
  **only at finalize**, once per turn, not per flush.
- **(b) `listByChat` recompute** — killed by the sibling table + narrow query
  (1.2): the streaming hot path never touches a document `listByChat` reads.
- **(c) the write-side O(n²) `appendDelta` string rewrite** — independent of (a)
  and (b): a single growing field is O(n²) to append-by-read-rewrite regardless
  of which table it lives in. **Position taken: accept it on the sibling row.**
  It is bounded by the bridge's ~50ms delta coalescing (`convex-writer.ts:164-178`,
  one mutation per flush, not per token) and by the per-turn reply length; at this
  metadata-only scale a single growing `streamingText.text` is simpler and
  correct. (Append-only chunk rows would remove the O(n²) write but add
  read-side concatenation + GC; rejected for now. Flip if a turn's reply length
  or flush rate ever makes the rewrite the bottleneck — the seam is internal to
  `stream.ts`, so the swap is local.)

### 1.2 Schema delta — new `streamingText` table (`convex/schema.ts`)

NEW table (no pre-existing rows → required fields are fine). **No search index;
no index `listByChat` consults.**

```ts
// Ephemeral live buffer for an in-flight assistant turn. EXACTLY ONE row per
// streaming message; deleted at finalize. Intentionally UN-INDEXED for search
// and NOT read by messages.listByChat, so a per-flush patch invalidates ONLY the
// narrow stream.liveByChat subscription — never the 200-message window or the
// per-part getUrl fan-out. messages.text stays the durable, searchable authority
// and is written ONCE at finalize.
streamingText: defineTable({
  messageId: v.id("messages"), // the streaming assistant message this buffers
  chatId: v.id("chats"),       // for the per-chat live subscription
  userId: v.id("users"),       // owner, for the access check in liveByChat
  text: v.string(),            // accumulated live text (sibling of messages.text)
  updatedAt: v.number(),
})
  .index("by_message", ["messageId"]) // upsert/delete from stream.* by message
  .index("by_chat", ["chatId"]),      // the narrow live subscription read set
```

Rationale for the columns: `chatId`/`userId` are denormalized so
`stream.liveByChat` resolves the row + its owner check **without** reading the
`messages` row (which would re-couple the read set to `listByChat`'s documents).

### 1.3 Query delta — new `stream.liveByChat` (`convex/messages.ts` or `convex/stream.ts`)

A **public, owner-scoped, narrow** reactive query the client subscribes to
*in addition to* `listByChat`. It reads ONLY `streamingText` rows for the chat —
this is the only query that re-runs per delta.

```ts
// Public reactive read of the LIVE streaming buffer for a chat. Returns at most
// the in-flight assistant rows ({ messageId, text }). The client merges these
// onto the matching streaming messages from listByChat (status === "streaming")
// and prefers the live text while streaming; at finalize the row is gone and
// listByChat's messages.text becomes authoritative (§1.5). Owner-scoped: same
// access boundary as listByChat.
export const liveByChat = query({
  args: { chatId: v.id("chats") },
  handler: async (ctx, { chatId }) => {
    const { userId } = await requireActive(ctx);
    const chat = await ctx.db.get(chatId);
    if (chat === null) return [];                 // chat just deleted -> empty
    if (chat.userId !== userId) throw new Error("Forbidden: chat not owned by user");
    const rows = await ctx.db
      .query("streamingText")
      .withIndex("by_chat", (q) => q.eq("chatId", chatId))
      .collect();                                  // bounded: ~1 in-flight turn
    return rows.map((r) => ({ messageId: r._id_message_unused_placeholder, text: r.text }));
    // (return { messageId: r.messageId, text: r.text } in impl)
  },
});
```

`.collect()` here is bounded by design: there is normally one in-flight assistant
turn per chat, and the row is deleted at finalize, so the live set stays at ~1.

### 1.4 Mutation deltas — `convex/stream.ts` (the load-bearing change)

The bridge's normalized stream ops keep their names; their bodies change so the
hot path patches the **sibling** row and `messages.text` is written once.

- **`startAssistant`** (`stream.ts:88-118`): after inserting the streaming
  `messages` row, ALSO insert the paired `streamingText` row
  `{ messageId, chatId, userId: chat.userId, text: "", updatedAt: now }`. Return
  `messageId` unchanged (the bridge contract is untouched).
  Keep the existing `ctx.db.patch(chatId, { updatedAt: now })` here — it runs
  **once** at turn start (it must, to sort the chat to the top), NOT per delta.

- **`appendDelta`** (`stream.ts:122-137`): patch the **`streamingText`** row, not
  `messages`. Look it up by `by_message`, set `text: row.text + text`,
  `updatedAt: now`. **Do NOT patch `messages` and do NOT patch `chats`.** This is
  the hot path; it must touch exactly one document.

  > HOT-PATH INVARIANT (load-bearing): one streaming delta patches EXACTLY the one
  > `streamingText` row. No `messages` patch (would re-index search + invalidate
  > `listByChat`), no `chats.updatedAt` patch (would invalidate the sidebar
  > `listChats`, `messages.ts:124-156`), no `messageParts` insert.

- **`setSnapshot`** (`stream.ts:140-152`): same redirection — replace
  `streamingText.text` with the snapshot. (The OpenClaw 5.19 snapshot path and
  the legacy-delta path both flow here; both stay on the sibling row.)

- **`addPart`** (`stream.ts:159-177`): UNCHANGED. Tool/reasoning/media parts go to
  `messageParts` and ARE read by `listByChat`. This is correct and intended:
  parts are low-frequency, structural, and must be authoritative/persisted
  immediately so the "show tools OpenClaw executes" toggle and media render off
  `useQuery`. (Per-part inserts do invalidate `listByChat`, but they are rare vs
  text tokens — they are not the amplifier.)

- **`finalize`** (`stream.ts:185-219`): THE reconcile point.
  1. Read the `streamingText` row by `by_message`.
  2. Patch `messages`: `status`, `text: text ?? streamingText.text ?? message.text`
     (the bridge's authoritative final text wins; else the accumulated live text;
     else whatever was already there), `error`, `updatedAt`. **This single write
     is the only one that re-indexes `search_text` for the turn.**
  3. `ctx.db.delete(streamingText._id)` — drop the live buffer so `liveByChat`
     stops returning it (the client then reconciles to the Convex final text,
     §1.5). Be tolerant if the row is already gone (compaction reset, below).
  4. Keep the existing `traceStream(phase:"finalize", …)` (metadata only).

  Note: `finalize` already accepts the bridge's final text (`stream.ts:202`); we
  now also fall back to the sibling buffer when the bridge omits it.

### 1.5 Client reconciliation (informational — frontend, not this PR)

The client subscribes to BOTH `listByChat` and `liveByChat`. While a message has
`status === "streaming"`, the UI prefers `liveByChat`'s text for that
`messageId`; tool/media/reasoning parts always come from `listByChat`
(`messageParts`). When `finalize` lands (`status` → terminal, `streamingText` row
deleted), `listByChat`'s `messages.text` is authoritative and the live buffer is
gone — no double render. On refresh mid-stream, `listByChat` shows the message
with whatever `messages.text` held (empty until finalize, since deltas no longer
patch it) PLUS the `liveByChat` buffer (still present until finalize) — so live
text is NOT lost on a reconnect because it lives in a durable Convex row, not an
ephemeral channel. This is strictly better than the §4 `live-hub` reconnect story
(no tokens stranded in a non-persistent socket).

### 1.6 Compaction interaction (normalizer-driven, no extra op)

On an OpenClaw auto-compaction the normalizer discards the partial run and resets
(`normalizer.ts:512-543`, `resetForCompaction`). The bridge currently has no op to
zero the live buffer. Two options, pick at implement time:
- **Preferred:** add a thin ingest op `resetStream(messageId)` →
  `internal.stream.resetStream` that sets `streamingText.text = ""`. This makes
  the live display blank-and-replay match the normalizer, instead of showing
  pre-compaction text until the replay overwrites it. (Optional; without it the
  next `setSnapshot`/delta still overwrites, just less crisply.)
- Either way `finalize` already tolerates a missing/empty buffer.

---

## Part 2 — Inbound + outbound media

The `messagePart` `media`/`file` variants already carry `storageId`
(`schema.ts:33-44`) and `listByChat` already resolves `storageId → signed URL`
via `ctx.storage.getUrl` (`messages.ts:86-98`, returns the URL, never the raw
storageId). **Signed-URL exposure is already correct** — no change needed there.
What changes: how bytes get INTO storage (outbound), and how outbound user
attachments reach the bridge (inbound).

### 2.1 Outbound media (OpenClaw created a file → user retrieves it in chat)

This realizes BRIDGE_ARCHITECTURE §4.4. **Invariant fixed:** no OpenClaw
filesystem path may cross into a Convex mutation arg / action body / trace. Today
`addMedia` POSTs a raw `path` and the ingest action fetches it
(`bridge_ingest.ts:203-249`) using `OPENCLAW_MEDIA_BASE_URL` — that ships an
OpenClaw fs path into Convex, violating the invariant.

Corrected flow (bytes are read bridge-side, uploaded to Convex storage, only the
opaque `storageId` crosses):

1. **New ingest op `generateUploadUrl`** (`convex/bridge_ingest.ts`): add a case
   to the `ingest` httpAction (Bearer `BRIDGE_INGEST_SECRET` already enforced,
   `bridge_ingest.ts:103-118`) that returns `await ctx.storage.generateUploadUrl()`.
   Mirrors the browser-facing `chats.generateUploadUrl` (`chats.ts:204-210`) but
   on the bridge-authed server seam (no user identity; the bridge is trusted).

2. **`bridge_ingest.ts` `addMedia` op CHANGED**: drop `path` and the
   `OPENCLAW_MEDIA_BASE_URL` fetch (`bridge_ingest.ts:203-249`). The new op body
   is just: `internal.stream.addPart({ messageId, part: { kind: "media",
   storageId, filename, mimeType } })`. The `storageId` arrives in the op (the
   bridge already uploaded the bytes via the URL from step 1). The
   `messageId`-correlated trace keeps logging `mimeType` only — never
   filename/path (PHI discipline, `bridge_ingest.ts:243-247`).

3. **`IngestOp` type CHANGED in two mirrored places** — `bridge_ingest.ts:82-100`
   AND `bridge/src/convex-writer.ts:66-84` (kept in sync by hand). New shapes:
   ```ts
   | { op: "generateUploadUrl" }                              // -> { uploadUrl }
   | { op: "addMedia"; messageId: string; storageId: string;  // path REMOVED
       filename: string; mimeType: string | null }
   ```

4. **`bridge/src/convex-writer.ts` `ConvexWriter.addMedia` + `HttpConvexWriter`
   CHANGED** (bridge-side, listed for completeness — not Convex): `addMedia` now
   (a) reads bytes from `mediaOutboundDir` locally, (b) POSTs
   `generateUploadUrl`, (c) PUTs bytes to the returned URL to get a `storageId`,
   (d) POSTs `addMedia` with `{ storageId, filename, mimeType }`. The
   `addMedia(messageId, { filename, path, mimeType })` interface signature
   changes to `{ filename, storageId | bytes, mimeType }`.

5. **OPTIONAL robustness (grounded findings):** instead of path-sniffing the
   streamed `data.mediaUrls`, the bridge MAY pull generated files
   authoritatively via the gateway `artifacts.list({ sessionKey })` +
   `artifacts.download({ sessionKey, artifactId })` (download `mode: "bytes" →
   base64`, `"url" → fetch`, `"unsupported" → marker`). The Convex side is
   identical (bytes → storage → `storageId` → `addMedia`); only the bridge's
   acquisition strategy differs. No Convex change required for this option.

`OPENCLAW_MEDIA_BASE_URL` becomes **unused on the Convex side** and should be
removed from the deployment env once `addMedia` stops fetching (the fs base URL
was the invariant-violating part).

### 2.2 Inbound media (user sends a file → OpenClaw)

The browser path is already built and correct: `chats.generateUploadUrl` →
browser uploads → `uploads.registerUpload` records ownership
(`uploads.ts:30-50`) → `send.sendMessage` enforces the IDOR gate
(`assertOwnsUpload`, `send.ts:91-93`) and attaches `messageParts` (kind `file`,
`send.ts:108-119`) → the `storageId`s land on `outbox.attachmentIds`
(`send.ts:126-134`). **No change to that ingress.**

The genuinely-new gap is the **dispatch**: `bridge.dispatch` forwards raw
`attachmentIds` (`bridge.ts:196`), but the bridge cannot dereference a Convex
`storageId` — it has no storage access. Fix in `convex/bridge.ts`:

1. **`bridge.getOutbox` / dispatch (`bridge.ts:114-224`)**: before POSTing to the
   bridge `/send`, resolve each `attachmentId` to a **signed download URL** via
   `ctx.storage.getUrl(id)`. Because `dispatch` is an `internalAction` (no
   `ctx.db`/`ctx.storage` directly for `getUrl`? — `getUrl` IS available in
   actions), it can call `ctx.storage.getUrl` directly; if resolving in a query
   is preferred, add an `internalQuery` `bridge.resolveAttachments(outboxId)`
   that maps `attachmentIds → [{ url, filename, mimeType }]`. The browser-known
   filename/mimeType come from the `messageParts` (kind `file`) rows attached in
   `send.sendMessage`, so add those to the resolved record.
2. The dispatch body sends `attachments: [{ url, filename, mimeType }]` (signed
   URLs) instead of raw `attachmentIds` (`bridge.ts:186-197`). The bridge fetches
   each URL server-side, base64-encodes, and forwards to the gateway `chat.send`
   `attachments[]` in the flat runtime shape `{ type?, mimeType, fileName,
   content: <base64> }` (grounded findings: `attachment-normalize.ts` dual
   shape; 20MB default cap; image sub-cap).
3. Trace stays metadata-only: log `attachmentCount` + `mimeType`s, never the URL,
   filename, or bytes (`bridge.ts:34-66` discipline).

No schema change for inbound: `messageParts` (kind `file`) +
`outbox.attachmentIds` (`schema.ts:234-285`) already cover it.

### 2.3 Signed-URL exposure (summary)

- **Render path (browser):** `listByChat` resolves `storageId → getUrl`
  (`messages.ts:86-98`). Already correct; `storageId` is never returned raw.
- **Outbound ingest (bridge → storage):** `generateUploadUrl` op (2.1.1) — short
  -lived signed PUT URL, bridge-authed.
- **Dispatch (storage → bridge):** `getUrl` signed GET URLs in the dispatch body
  (2.2.1). Short-lived; the only place an attachment URL crosses to the bridge,
  server-to-server, never to the browser.

---

## Part 3 — History reconciliation persistence

Goal (spec items 4 + 5): after an OpenClaw-side compaction or session archival,
**OpenClaw's real context must match what the user sees**. The bridge pulls the
gateway transcript (`chat.history({ sessionKey })`, display-normalized per
grounded findings; `sessions.compaction.*` for archived recovery) and reconciles
it into Convex. This is the persistence side only.

### 3.1 Mutation + ingest op — `reconcileHistory`

- **New `internalMutation` `stream.reconcileHistory`** (`convex/stream.ts`):
  ```ts
  args: {
    chatId: v.id("chats"),
    // Display-normalized transcript from the gateway (NON-secret, no fs paths).
    transcript: v.array(v.object({
      role: v.union(v.literal("user"), v.literal("assistant"), v.literal("system")),
      text: v.string(),
      runId: v.optional(v.string()),
      serverSeq: v.optional(v.number()), // gateway message ordinal, for dedupe
    })),
  }
  ```
  Behavior: **idempotent upsert, replay-safe, never clobbers local optimistic
  state.** For each transcript entry, match an existing `messages` row by
  `(chatId, runId)` when `runId` is present, else by `(chatId, serverSeq)` when
  the optional `messages.serverSeq` delta (3.3) is adopted; if matched, patch
  `text`/`status:"complete"` only when it differs; if unmatched, insert. **Never
  delete** local messages the gateway no longer lists (a compaction summarizes —
  the user's view of their own turns must persist). Skip entries that collide
  with an in-flight (`status:"streaming"`) message so a reconcile mid-turn cannot
  stomp the live buffer.

- **New ingest op `reconcileHistory`** (`convex/bridge_ingest.ts`): a case that
  forwards the transcript array to `internal.stream.reconcileHistory`. Trace
  metadata only: `{ chatId, entryCount }` — **never** the transcript text
  (`bridge_ingest.ts` PHI rule).

- **`IngestOp` type** gains
  `{ op: "reconcileHistory"; chatId: string; transcript: [...] }` in both mirrors
  (`bridge_ingest.ts` + `convex-writer.ts`), and `ConvexWriter` gains a
  `reconcileHistory(chatId, transcript)` method.

### 3.2 When it runs (bridge-side trigger — informational)

The bridge calls `reconcileHistory` (a) on a typed compaction signal
(`sessions.operation` `operation:"compact"`, `phase:"end"` per grounded findings
— more reliable than the untyped `livenessState:"abandoned"` heuristic the
normalizer keys on today, `normalizer.ts:519-533`), and (b) on (re)attaching to a
chat whose session was archived. No Convex change for the trigger; Convex only
exposes the idempotent sink.

### 3.3 Optional schema deltas (additive, on existing `messages` / `chats`)

Both OPTIONAL per the task; adopt the one that fits the bridge's dedupe key:
- `messages.serverSeq: v.optional(v.number())` — gateway message ordinal, so
  reconcile can match-by-position when no `runId` is present (and to detect
  re-orderings after a compaction). Additive on existing rows.
- `chats.lastReconciledAt: v.optional(v.number())` — watermark so the bridge can
  ask "reconcile only since X" and skip re-walking the whole transcript. Additive.

Neither is required for a correct first cut (match-by-`runId` covers assistant
turns); they are the dedupe/efficiency affordances.

---

## Summary — exact Convex files/functions to change

| File | Change |
| --- | --- |
| `convex/schema.ts` | ADD table `streamingText` (1.2). OPTIONAL: `messages.serverSeq`, `chats.lastReconciledAt` (3.3). `messagePart` unchanged. |
| `convex/stream.ts` | `startAssistant` also inserts `streamingText` row; `appendDelta`/`setSnapshot` patch `streamingText` (NOT `messages`/`chats`); `finalize` writes `messages.text` once + deletes `streamingText`; ADD `liveByChat` query (or in messages.ts), `reconcileHistory` internalMutation, optional `resetStream`. |
| `convex/messages.ts` | UNCHANGED (kills amplifiers by NOT reading `streamingText`). `liveByChat` may live here instead of stream.ts. |
| `convex/bridge_ingest.ts` | ADD ops `generateUploadUrl`, `reconcileHistory`; CHANGE `addMedia` (drop `path` + `OPENCLAW_MEDIA_BASE_URL` fetch → take `storageId`); update `IngestOp`. |
| `convex/bridge.ts` | `dispatch`/new `resolveAttachments` internalQuery: resolve `outbox.attachmentIds → signed getUrl + filename/mimeType`; send signed URLs (not raw ids) in `/send` body. |
| `bridge/src/convex-writer.ts` | (bridge) mirror `IngestOp`; `addMedia` reads bytes locally → `generateUploadUrl` → upload → `addMedia({storageId,...})`; add `reconcileHistory`. |

Deployment env: `OPENCLAW_MEDIA_BASE_URL` becomes obsolete (2.1) once `addMedia`
no longer fetches.

Invariants preserved: per-user isolation (`liveByChat` owner-scoped like
`listByChat`; dispatch/ingest unchanged on ownership); secrets stay bridge-side
(only opaque `storageId` + signed short-lived URLs cross; no fs path enters
Convex); PHI never logged (traces stay metadata-only). All existing-table schema
deltas are OPTIONAL.
