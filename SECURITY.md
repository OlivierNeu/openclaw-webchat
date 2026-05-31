# Security Policy

## Supported Versions

This project is currently pre-`1.0`. Security fixes are accepted on `main`.

## Security Model

The bridge is designed so that:

- OpenClaw Gateway tokens never reach the browser;
- device identities stay server-side;
- generated media is served through short-lived, session-scoped signed URLs;
- local OpenClaw paths are sanitized before reaching the browser;
- Firebase ID tokens are verified server-side;
- sign-out closes the browser WebSocket;
- frames are only forwarded when their `payload.sessionKey` matches the current
  session.

## Sensitive Data

Do not commit:

- Firebase service account JSON files;
- OpenClaw Gateway tokens;
- OpenClaw device identity private keys;
- frame captures containing real prompts, answers, session keys or media paths;
- `.env` files;
- local `config.local.json` files.

## Reporting a Vulnerability

Please do not open a public issue for vulnerabilities involving credentials,
path disclosure or cross-session data exposure.

Contact the maintainer privately with:

- affected version or commit;
- deployment mode;
- reproduction steps;
- expected impact;
- suggested mitigation if known.

## Hardening Checklist

- Configure `ALLOWED_EMAILS` or `ALLOWED_EMAIL_DOMAINS`.
- Configure `ALLOWED_ORIGINS` for split frontend/backend deployments.
- Keep `OPENCLAW_MEDIA_LINK_SECRET` stable and private.
- Keep `OPENCLAW_MEDIA_LINK_TTL_SECONDS` as short as practical.
- Mount media directories read-only.
- Disable `ALLOW_DEV_AUTH` outside local development.
- Terminate TLS before browser traffic reaches the bridge.
- Ensure reverse proxy WebSocket upgrade support.
- Rotate OpenClaw tokens if exposed in logs or traces.
