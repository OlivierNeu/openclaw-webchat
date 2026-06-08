# Deployment

> **✅ PROD DEPLOY CHECKLIST (multi-agent, do IN ORDER — each step prevents an
> outage; the two blocks below give the why):**
> 1. **Wipe the target Convex app data** (disposable; only admin + a pending user
>    in prod) — else the schema-clean `convex deploy` FAILS validation.
> 2. **`convex deploy`** (the old bridge ignores the new body fields, so
>    Convex-first is safe) — sets `BRIDGE_INSTANCE_NAME` per deployment.
> 3. **Create ONLY the instance this bridge serves** in the `instances` table
>    (a user assigned an agent on a non-served instance will 409 cleanly but see
>    "indisponible").
> 4. **Set the bridge env**: `OPENCLAW_INSTANCE_NAME` == that `instances.name` ==
>    `BRIDGE_INSTANCE_NAME`; remove `OPENCLAW_AGENT_ID`/`OPENCLAW_CANONICAL`.
> 5. **Ship the new bridge image** (it hard-requires body routing — shipping it
>    before step 2 makes every send 400).

> **⚠️ SCHEMA-CLEAN DEPLOY (multi-agent redesign, 2026-06-07) — READ BEFORE
> `convex deploy`.** The multi-agent schema **drops** the legacy routing columns
> (`groups` table + `profiles.{groupId, overrideInstance, overrideAgentId,
> allowedChatPrefixes}`, `userAgents.needsReassignment`, source `"migrated"`).
> Convex schema validation is **strict**: it rejects deploying a schema that drops
> a column while any existing document still carries it. So this is a **clean-slate
> deploy** — there is no migration (operator-confirmed: no data to preserve).
>
> Procedure for the target (NAS self-hosted) deployment:
> 1. **Wipe the app data first** (the data is disposable; only `admin` + a
>    `pending` user exist in prod). Clear the legacy-carrying tables, or reset the
>    whole app DB — the app re-bootstraps the first signed-in account to `admin`.
> 2. `convex deploy` the new schema (now validates against empty/clean data).
> 3. First admin login re-creates the profile cleanly; assign agents via Users →
>    "Gérer les agents".
>
> Skipping step 1 makes `convex deploy` **fail** schema validation (this is the
> Codex P1 caution). Rehearsed locally: `dev.reset` purged the DB → schema valid
> on empty → app re-bootstrapped admin clean. See `docs/MULTI_AGENT_REDESIGN.md`
> §4.0. *(If you ever need a zero-downtime deploy WITH legacy data present, the
> alternative is to re-add the dropped columns as `v.optional(...)` and clear them
> in a follow-up — but that re-introduces dead columns and is not the chosen path.)*

> **⚠️ DEPLOY ORDER (Phase 2a body-routing) — Convex BEFORE the bridge.** The new
> bridge image HARD-REQUIRES `agentId` + `canonical` on every `/send|/patch|/reset`
> body (it 400s with no env fallback — that fallback was the prod bug). Convex's
> `bridge.dispatch` is what supplies those fields. So:
> 1. `convex deploy` FIRST (the OLD bridge simply ignores the extra body fields, so
>    a Convex-first rollout is safe and causes no outage).
> 2. THEN ship the new bridge image.
> Shipping the bridge first → **every send 400s** until Convex catches up.
> Also set `OPENCLAW_INSTANCE_NAME` on each bridge (== its Convex `instances.name`
> == that deployment's `BRIDGE_INSTANCE_NAME`) to activate the M2 cross-instance
> guard. The bridge no longer reads `OPENCLAW_AGENT_ID` / `OPENCLAW_CANONICAL` —
> remove them from the bridge env. See `docs/MULTI_AGENT_REDESIGN.md` §4 Phase 2a.

> **ARCHITECTURE NOTE (2026-06):** Modes A/B and the original "Media Volume"
> section below describe the **LEGACY** backend (Firebase frontend + FastAPI
> signed-media `/api/media/outbound`). The project has since migrated to
> **Convex (self-hosted) + the `bridge/` service**. For the CURRENT outbound-media
> share (the bridge reads `media/outbound` from a `:ro` mount and STREAMS bytes to
> Convex — no signed URLs, no base64), see **"Current architecture: media share"**
> at the end of this doc + `bridge/docker-compose.yml` + `docs/MEDIA_TRANSFER_DESIGN.md`.

The project supports two first-class deployment modes.

## Mode A: Firebase Frontend + Synology Backend

Use this mode when you want fast frontend deployments while keeping the bridge
near your OpenClaw instances.

```text
Firebase Hosting
  -> wss://openclaw-webchat-api.example.com/ws/chats/{chatId}
  -> Synology Docker backend
  -> OpenClaw Gateway
```

Frontend build:

```bash
cd frontend
npm install
VITE_OPENCLAW_BRIDGE_WS_URL=wss://openclaw-webchat-api.example.com npm run build
firebase deploy --only hosting
```

Backend deployment:

```bash
cd openclaw-webchat
export OPENCLAW_MEDIA_LINK_SECRET="<stable secret>"
export OPENCLAW_MEDIA_OUTBOUND_HOST_DIR="/volume3/openclaw/media/outbound"
export OPENCLAW_WEBCHAT_PUBLIC_BASE_URL="https://openclaw-webchat-api.example.com"
docker compose build
docker compose up -d
```

For this split mode, the all-in-one image still works. The frontend embedded in
the image is simply not the public UI. `OPENCLAW_WEBCHAT_PUBLIC_BASE_URL` is
required in split mode so signed media links point to the backend origin instead
of the Firebase Hosting origin.

## Mode B: Synology All-In-One

Use this mode when you want one container similar to Open WebUI: frontend,
backend, WebSocket and media proxy all served from the same origin.

```text
https://chat.example.com/
  -> FastAPI static frontend
  -> /ws/chats/{chatId}
  -> /api/media/outbound/{filename}
  -> OpenClaw Gateway
```

Leave `VITE_OPENCLAW_BRIDGE_WS_URL` empty at build time. The browser will use
the current host.

Leave `OPENCLAW_WEBCHAT_PUBLIC_BASE_URL` empty in this mode so media links stay
relative to the same origin.

Required variables:

```bash
# Copy and edit your routing config first (never run with config.example.json).
cp config.example.json config.json
export OPENCLAW_WEBCHAT_CONFIG_HOST_FILE="$PWD/config.json"

export OPENCLAW_MEDIA_LINK_SECRET="<stable secret>"
export OPENCLAW_MEDIA_OUTBOUND_HOST_DIR="/path/to/shared/openclaw/media/outbound"
export FIREBASE_PROJECT_ID="<firebase-project>"
# Access allowlist — set the domains/emails you actually authorize.
export ALLOWED_EMAIL_DOMAINS="example.com"
# Gateway secrets referenced by config.json (rename to match your instances):
export OPENCLAW_ALICE_GATEWAY_TOKEN="..."
export OPENCLAW_ALICE_DEVICE_IDENTITY='{"id":"...","publicKey":"...","privateKey":"..."}'
```

Then:

```bash
docker compose build
docker compose up -d
```

## Reverse Proxy Requirements

The reverse proxy must support WebSocket upgrade headers:

```text
Connection: Upgrade
Upgrade: websocket
```

TLS should terminate before the bridge or at the bridge domain. Browser clients
must use `wss://` from HTTPS pages.

## Media Volume

Generated OpenClaw files are served by the bridge through signed URLs. The
backend container needs read-only access to the OpenClaw outbound media
directory.

```yaml
volumes:
  - /path/to/shared/openclaw/media/outbound:/home/node/.openclaw/media/outbound:ro
```

### Multi-instance requirement (important)

The bridge serves media by reading a **single** local directory
(`OPENCLAW_MEDIA_OUTBOUND_DIR`, mounted from `OPENCLAW_MEDIA_OUTBOUND_HOST_DIR`).
It has no per-instance dimension. When `config.json` defines more than one
OpenClaw instance, each instance is a separate container writing to its own
`~/.openclaw/media/outbound`.

Therefore **every OpenClaw instance must write into one shared outbound
directory**. Back it with shared storage (an NFS export or a single shared
Docker volume) mounted into:

- every OpenClaw container at `/home/node/.openclaw/media/outbound`, and
- the bridge (read-only) via `OPENCLAW_MEDIA_OUTBOUND_HOST_DIR`.

Caveats:

- **Per-instance 404**: if instances keep separate dirs and you mount only one,
  signed links work only for that instance; files produced by any other
  instance return HTTP 404 *Media not found* (with a valid signature, because an
  absent file yields an empty fingerprint that still validates, failing only at
  the final filesystem check).
- **Filename collisions**: a single flat shared dir means two instances emitting
  the same filename overwrite/shadow each other, and the bridge cannot tell them
  apart (links are authorized per session but the file read is instance-agnostic).
  Configure each instance to write under an instance-specific subdirectory, or
  use UUID/instance-prefixed filenames.

If you cannot share a directory across instances, do not rely on local-FS media
serving for a multi-instance deployment.

## Current architecture: media share (bridge → Convex, streaming)

The current bridge does NOT serve signed media URLs. For an outbound attachment
it (1) reads the agent-produced file from a **read-only mount** of OpenClaw's
`media/outbound`, and (2) **streams the raw bytes** to a Convex upload URL
(`generateUploadUrl`), persisting the `storageId` as a `kind:media` part. No
base64, no size ceiling (see `docs/MEDIA_TRANSFER_DESIGN.md`).

So the only deployment requirement is: **the bridge and every OpenClaw container
share the same `media/outbound` directory, mounted read-only into the bridge** at
`OPENCLAW_MEDIA_OUTBOUND_DIR` (default `/home/node/.openclaw/media/outbound`).
`bridge/docker-compose.yml` is the reference. OpenClaw's `<name>---<uuid>.<ext>`
filenames are UUID-suffixed, so the single shared flat dir has no collisions.

### NAS (production) — co-located, shared named volume
OpenClaw, self-hosted Convex and the bridge run in the same compose. The OpenClaw
service mounts the shared volume read-WRITE; the bridge mounts it read-only:

```yaml
# openclaw service:
volumes: [ media-outbound:/home/node/.openclaw/media/outbound ]
# bridge service (bridge/docker-compose.yml):
volumes: [ media-outbound:/home/node/.openclaw/media/outbound:ro ]
volumes: { media-outbound: {} }   # ONE volume shared by all OpenClaw instances
```

Validate on the NAS: ask the agent (via the webchat) to produce a file → it must
render as a downloadable attachment whose bytes match. Re-run per OpenClaw
version (the dev/regression bench is the **olivier** instance; **jerome** is
protected).

### Local dev — two options
The bridge runs on the Mac (`npm start`) against a gateway. To read real agent
files locally you need the gateway's `media/outbound` reachable as a local dir:

- **(a) Co-located local OpenClaw** (matches NAS): run OpenClaw + bridge in a
  local compose sharing the `media-outbound` volume (cleanest, faithful).
- **(b) Mount the remote gateway dir** when using the remote olivier gateway from
  the Mac bench:
  ```bash
  sshfs <user>@<gateway-host>:/home/node/.openclaw/media/outbound /tmp/oc-media
  # then in bridge/.env:
  OPENCLAW_MEDIA_OUTBOUND_DIR=/tmp/oc-media
  ```
  (rsync into a local dir on a timer also works.) Then trigger a real agent file
  and confirm it renders byte-exact in the webchat.

If neither is set up, the bridge logs `[media] skip <file>: not found` and the
turn still streams text/tools — only the attachment is missing.

> **Container → host gotcha (local docker only):** if you run the bridge *in a
> container* against a Convex running on the host (`npx convex dev` on
> 127.0.0.1:3213), set `CONVEX_HTTP_ACTIONS_URL=http://host.docker.internal:3213`
> — inside a container `127.0.0.1` is the container itself. On the NAS, Convex is
> a compose service reachable by name (e.g. `http://convex-backend:3211`), so this
> only affects local docker testing. (Running the bridge as a plain `npm start`
> node process on the Mac needs no change.)

## Production Checklist

- `ALLOW_DEV_AUTH` is not enabled.
- `OPENCLAW_MEDIA_LINK_SECRET` is long, stable and not committed.
- `OPENCLAW_MEDIA_LINK_TTL_SECONDS` is appropriate for your workflow.
- `OPENCLAW_WEBCHAT_PUBLIC_BASE_URL` is set for split frontend/backend deployments.
- `ALLOWED_EMAIL_DOMAINS` or `ALLOWED_EMAILS` is configured.
- `ALLOWED_ORIGINS` is restricted when using split frontend/backend hosting.
- Gateway tokens and device identities are injected through environment
  variables or secret management.
- Reverse proxy supports WebSocket upgrades.
- Media directory is mounted read-only.
- `/api/capabilities` returns expected feature flags.
- Browser sign-out closes the WebSocket.
