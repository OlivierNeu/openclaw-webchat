# Configuration

OpenClaw WebChat is configured through environment variables and one routing
JSON document.

## Required Runtime Variables

| Variable | Required | Description |
| --- | --- | --- |
| `OPENCLAW_WEBCHAT_CONFIG_FILE` or `OPENCLAW_WEBCHAT_CONFIG` | yes | User to instance routing configuration. |
| `FIREBASE_PROJECT_ID` | production | Firebase project used to verify ID tokens. |
| `GOOGLE_APPLICATION_CREDENTIALS` | production | Service account JSON path for Firebase Admin SDK. |
| `OPENCLAW_MEDIA_LINK_SECRET` | yes | Stable HMAC secret for media URLs. |
| `OPENCLAW_MEDIA_LINK_TTL_SECONDS` | optional | Signed media URL lifetime. Defaults to `3600`, clamped between 60 seconds and 86400 seconds. |
| `OPENCLAW_MEDIA_OUTBOUND_DIR` | yes for media | In-container path to generated OpenClaw outbound files. |
| `OPENCLAW_WEBCHAT_PUBLIC_BASE_URL` | split deployments | Public HTTP(S) origin of the bridge, used to generate absolute signed media links. Accepts `http(s)` or `ws(s)` and normalizes WebSocket schemes to HTTP schemes. |
| `ALLOWED_EMAIL_DOMAINS` or `ALLOWED_EMAILS` | recommended | Access allowlist. |
| `ALLOWED_ORIGINS` | recommended | Comma-separated CORS origins. Defaults to `*`. |

## Development Variables

| Variable | Description |
| --- | --- |
| `ALLOW_DEV_AUTH=true` | Enables `dev:<email>` tokens. Never use in production. |
| `OPENCLAW_WEBCHAT_STATIC_DIR` | Enables FastAPI static frontend serving. |

## Frontend Build Variables

| Variable | Description |
| --- | --- |
| `VITE_FIREBASE_API_KEY` | Firebase web app API key. |
| `VITE_FIREBASE_AUTH_DOMAIN` | Firebase auth domain. |
| `VITE_FIREBASE_PROJECT_ID` | Firebase project ID. |
| `VITE_FIREBASE_APP_ID` | Firebase web app ID. |
| `VITE_OPENCLAW_BRIDGE_WS_URL` | Explicit backend WebSocket base URL. Leave empty in all-in-one Docker mode. |
| `VITE_DEV_ID_TOKEN` | Development-only token, for example `dev:alice@example.com`. |

## Routing Configuration

See `config.example.json`.

Each user entry maps one Firebase email to:

- an OpenClaw instance name;
- an OpenClaw agent ID;
- a canonical user key;
- a display name;
- `allowedChatPrefixes` (optional): a list of allowed `chatId` prefixes. When
  non-empty, the bridge rejects any WebSocket whose `chatId` does not start with
  one of them, restricting which chat namespaces the user may open. An empty
  list (or omitting the field) means no restriction.

Each instance entry defines:

- Gateway WebSocket URL;
- token or token environment variable;
- device identity or device identity environment variable.

Secrets should be provided through environment variables, not committed in JSON.
The example `config.json` env names (`OPENCLAW_ALICE_GATEWAY_TOKEN`, ...) are
referenced by `tokenEnv` / `deviceIdentityEnv`; rename them to match your own
instances.

The runtime config file is never the committed `config.example.json`. Copy it
first:

```bash
cp config.example.json config.json   # then edit, and set
export OPENCLAW_WEBCHAT_CONFIG_HOST_FILE="$PWD/config.json"
```

## Session Key Strategy

The backend generates session keys as:

```text
agent:<agentId>:webchat:chat:<canonical>:<chatId>
```

This keeps webchat sessions separate from Open WebUI sessions while preserving
OpenClaw-native persistence.
