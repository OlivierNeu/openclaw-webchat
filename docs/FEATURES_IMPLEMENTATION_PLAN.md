## Deliverable

Authored **`docs/FEATURES_IMPLEMENTATION_PLAN.md`** — a coordinated, cross-layer, phased plan that is the *feature-indexed view* of the build (it cross-references, never renumbers, the structural phases P1–P7 in `BRIDGE_IMPLEMENTATION_PLAN.md`).

## Structure (per the "parallel agents between layers" model)
Each capability has: **THE SEAM** (the fixed cross-layer contract — pinned first so backend/bridge/frontend build simultaneously) → **per-layer deltas** (with file:line) → **dependency order + bridge-plan phase** → **acceptance gate** (offline `tsc`/tests + the live `F-id` it turns GREEN).

Capabilities: C-MULTIPLEX (Phase A, P2 → F1/F8), C-HARNESS (A′, parallel), C-STREAM (B, P7 → F3), C-MARKERS (C → F6/F7), C-MEDIA-IN/OUT (D → F2-in/out), C-COMPACT (E → F4), C-RECON (F → F5), C-MULTIUSER (G → F9). Includes a parallelization wave plan and a master F-id→phase→gate table.

## CHALLENGE issues — all verified against code, then resolved as "current → target" work items (not debated)
- **G-A2** (A2 un-indexed field doesn't exist): confirmed `stream.ts:132,150` patch the indexed `text`; `schema.ts:228-231` search-indexes that same field. → C-STREAM sibling `streamingText` table; `messages.text` written only at finalize.
- **G-RUN** (run.status dropped): confirmed `turn-sink.ts:126-128`. → C-MARKERS adds a backend `runState` channel; stop dropping in the sink.
- **G-COMPACT** (unverified `abandoned` signal): confirmed `normalizer.ts:524`. → C-COMPACT is capture-first/BLOCKING: capture `/compact` frames live, settle the authoritative field, then re-key.
- **G-HIST** (`chat.history` unimplemented): confirmed deferred-only at `normalizer.ts:338,482`. → C-RECON is a NEW gated capability (`chat.history` pull + idempotent `(chatId,runId)` upsert).
- **G-MEDIA-OUT** (path-leak): confirmed `bridge_ingest.ts:208,218` fetches `OPENCLAW_MEDIA_BASE_URL+path`. → invert: bridge reads bytes via `artifacts.download`, `addMedia` takes `{storageId,...}`.

## The one finding that moved a feature across a phase boundary
The CHALLENGE's "F-MULTIUSER unbuildable — no `instanceName→token` map" is the multi-**instance** case the harness **forbids**. Verified against `OPENCLAW_CONNECTION_MODEL.md` §Q4: Model A multiplexes all sessions over one operator socket gated by scope, not user, so **F9 (two users, same single instance) needs no second token** — the single-identity `config.ts` (verified: one `OPENCLAW_TOKEN`/`OPENCLAW_DEVICE_IDENTITY` from env) is correct. **F9 rides P2 + a `dev.testSendAs` selector, NOT P5.** P5 is reserved for the case the harness does not exercise.

## Advisor-driven correction applied before finishing
The advisor caught a cross-capability contradiction: placing `runState` on `messages` would reintroduce the `listByChat` invalidation that C-STREAM exists to kill. Fixed — `runState` now lives on the `streamingText` sibling row (rides the existing `liveByChat` subscription, zero added invalidation), `dev.oracleByChat` reads it from there, and the `setRunState` IngestOp mirror is named for symmetry with `addMedia`.

All 10 requirements map to a phase; every phase carries offline gates + the live matrix feature it certifies; honesty section flags NOT-FOUND/unverified shapes (compaction field, `chat.history` normalization, `artifacts.download` modes, `chat.send` attachment shape, `abort` RPC) to pin via primary source or live fixture.