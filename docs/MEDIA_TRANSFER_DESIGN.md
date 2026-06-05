# Outbound media transfer — design & rationale (2026-06-05)

Research-backed answer to: *why does OpenClaw rely on base64/filesystem for files,
and what is the robust transfer architecture (no base64, no size ceiling)?*

## TL;DR

There are TWO independent transfer legs. Do not conflate them.

| Leg | Path | Current | Problem | Fix |
|-----|------|---------|---------|-----|
| **2. bridge → Convex** | the file bytes into Convex File Storage | ✅ **DONE** — `generateUploadUrl` + raw-binary **streaming** POST (was base64) | — | **proven live: a 5 MiB binary streamed byte-exact, zero base64, past the old 20 MB ceiling** |
| **1. gateway → bridge** | read the agent-produced file | local `:ro` **mount** of `media/outbound` | needs FS co-location/mount | (already base64-free, streaming) OR an **OpenClaw plugin** HTTP file endpoint to drop the mount |

**The base64 problem lives ONLY in Leg 2.** Fixing Leg 2 (upload URL) resolves the
user's stated concerns (size ceiling + binary/video inflation) completely, and is
independent of OpenClaw and of the mount. The plugin is an alternative to the
**mount** (Leg 1), NOT a fix for base64.

## Why OpenClaw uses base64 / filesystem (the "why")

Source: OpenClaw docs + our LIVE protocol capture (hello-ok `policy.maxPayload`).

- The gateway WS protocol is **JSON text frames** (`{"type":"event",...}`). Binary
  cannot ride a JSON frame except **base64-encoded inline**.
- Inline base64 is therefore capped by the WS frame limit: **`maxPayload = 26214400`
  (25 MiB)** — captured live from this gateway's hello-ok.
- So OpenClaw's design: **inbound** small files → base64 inline (`chat.send.attachments`,
  "inline images only" per our `docs/OPENCLAW_RESEARCH.md`); larger/binary → **offloaded
  to the filesystem** (`media://inbound/<id>`). **Outbound** agent files are written to
  `media/outbound/<name>---<uuid>` on the host and a co-located client reads them — there
  is **no binary file channel** and **no HTTP file endpoint** on the gateway (verified:
  `/api/*` all 404, surface = `/health` + WS + SPA).

> Honesty note: the above is from OpenClaw docs + the live hello-ok capture — NOT from a
> hands-on inbound file-send test. The 25 MiB `maxPayload` value is directly observed.

## Leg 2 fix — the correct Convex pattern (recommended, do now)

Source: https://docs.convex.dev/file-storage/upload-files

- `ctx.storage.generateUploadUrl()` (mutation/action) → short-lived URL (expires 1h).
- POST the file as **raw binary** (Content-Type = the real mime), NOT base64.
- Response: `{ storageId }` (`Id<"_storage">`).
- **File size is NOT limited** (only a 2-minute POST timeout). The 20MB cap applies ONLY
  to httpAction request bodies — i.e. exactly our current `addMediaBlob` path.
- Any HTTP client can POST — the bridge (server-side) streams the mounted file straight
  to the upload URL: `createReadStream(file) → POST uploadUrl` → storageId → `addPart`.

Net: disk → Convex with **zero base64, zero size ceiling, streaming** (no full buffer).
Replaces `addMediaBlob`; `MediaFetcher` becomes "give me a readable stream + mime" instead
of "give me bytes". `ConvexWriter.addMedia` interface can stay; only the impl changes.

## Leg 1 option — an OpenClaw plugin (strategic, NOT a base64 fix)

Source: https://docs.openclaw.ai/plugins/sdk-overview — plugins run **inside the gateway
process** and the `register(api)` callback exposes `api.registerHttpRoute(params)` and
`api.registerGatewayMethod(name, handler)` (precedent: the `admin-http-rpc` plugin
registers `POST /api/v1/admin/rpc`).

Idea: a plugin registers `GET /media/outbound/<file>` (streaming, ideally range) so the
bridge fetches file bytes over HTTP and pipes them to the Convex upload URL — **no mount,
deploy the bridge anywhere with just URL+token**. Strong fit for a *public, forkable*
bridge that shouldn't require FS co-location.

> Honesty note (UNVERIFIED): `registerHttpRoute` EXISTS, but its params, whether the
> handler can **stream binary / honor HTTP range**, and plugin **filesystem read** access
> are NOT documented in what we fetched (`api.runtime.system` does command execution,
> which is not a streaming file handler). This needs a SPIKE (read the SDK type defs or
> build a minimal route) before committing. Costs: trusted code in the gateway process,
> endpoint auth, maintenance across OpenClaw versions.

## Community signal — we are NOT alone wanting better than base64/filesystem

Researched 2026-06-05. The OpenClaw community has repeatedly raised exactly this:

- **Issue #11769 — "File Transfer OOM and 9-Minute Delays — Native Streaming Solution".** A
  contributor reports `nodes.invoke` file transfer reads whole files into RAM, base64s them
  (+33%), JSON-serializes → OOM on large files + **9+ minute** multi-GB transfers, and proposes
  **native Node HTTP streaming, zero memory overhead, raw binary (no base64), disk→network**, with
  token-gated single-connection transfers. Benchmarks: **1 GB in ~8 s, <10 MB RAM** vs 9+ minutes
  (~10,000×). **Status: closed as "not planned", stale, no maintainer response.** → the exact fix
  we built (streaming, no base64) was proposed upstream and *declined*.
- **Security advisory GHSA-w2cg-vxx6-5xjg (Moderate).** Large **base64** media is a DoS vector —
  buffers are allocated before size limits are checked. Patched the allocation order (≥2026.2.14),
  **not** the base64 approach. → base64 media is a recognized *security* liability, not just slow.
- **Issue #27303** — feature request for an HTTP REST endpoint; the gateway is **WS-only** (405 on
  POST). The "no HTTP endpoint" gap (which forced our filesystem mount) is a known community ask.
- **WS payload cap pain** — base64 over the WS hits frame limits (`maxPayload` 25 MiB here; the `ws`
  lib default is far smaller); third-party guides exist for "Max Payload Size Exceeded".
- **Issues #50312 / #19097 / CVE-2026-26321** — outbound media path validation is a restrictive
  hardcoded whitelist (`~/.openclaw/media|workspace|sandboxes|...`); repeated complaints that legit
  files get rejected and `mediaLocalRoots` isn't honored.
- **Issue #18454** — an inbound file-upload UI (base64 data URIs, 10 MB frame cap) was **closed as
  "not planned"**. Maintainers are not expanding the base64 path.

Conclusion: the base64/filesystem design is a *recognized, under-served* pain point. The maintainers
have declined both the native-streaming fix (#11769) and the HTTP-endpoint request (#27303), which
strengthens the case for solving it OUTSIDE the gateway — our bridge (Leg 2, done) and, optionally,
a plugin (Leg 1).

## Recommendation

1. **Now:** implement the Leg 2 upload-URL streaming fix — it removes base64 + the size
   ceiling, the user's actual concern. Independent, low-risk, no gateway changes.
2. **Decide:** the Leg 1 plugin is a strategic option to drop the mount. Greenlight a small
   spike first to verify streaming/range/fs before a full build.
