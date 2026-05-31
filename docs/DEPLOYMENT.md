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
export OPENCLAW_MEDIA_LINK_SECRET="<stable secret>"
export OPENCLAW_MEDIA_OUTBOUND_HOST_DIR="/volume3/openclaw/media/outbound"
export FIREBASE_PROJECT_ID="<firebase-project>"
export ALLOWED_EMAIL_DOMAINS="lacneu.com,ataraxis-coaching.com"
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

Example:

```yaml
volumes:
  - /volume3/openclaw/media/outbound:/home/node/.openclaw/media/outbound:ro
```

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
