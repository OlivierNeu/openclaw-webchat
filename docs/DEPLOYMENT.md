# Deployment

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
