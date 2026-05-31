# Contributing

Thanks for considering a contribution.

This project aims to be a professional, forkable OpenClaw webchat bridge. The
backend bridge contract matters more than the bundled reference frontend.

## Principles

- Keep OpenClaw credentials server-side.
- Document protocol changes before relying on them.
- Add regression tests for every OpenClaw frame shape that caused a bug.
- Prefer small, focused pull requests.
- Do not expose local filesystem paths to the browser.
- Do not make frontend code depend on private OpenClaw implementation details.

## Local Checks

```bash
cd openclaw-webchat
python -m py_compile backend/app/*.py backend/tests/test_core.py
PYTHONPATH=backend OPENCLAW_MEDIA_LINK_SECRET=test-secret \
  pytest -q backend/tests/test_core.py

cd frontend
npm run build
```

## Pull Request Checklist

- [ ] The change is documented.
- [ ] Backend protocol changes are reflected in `docs/BRIDGE_PROTOCOL.md`.
- [ ] Deployment changes are reflected in `docs/DEPLOYMENT.md`.
- [ ] Security-sensitive changes are reflected in `SECURITY.md`.
- [ ] Tests cover new OpenClaw frame shapes or frontend contract changes.
- [ ] No secrets, traces with sensitive content, or local paths are committed.

## Commit Style

Use clear imperative commits:

```text
Add signed media URL support
Document Synology all-in-one deployment
Reject WebSocket frames without matching sessionKey
```

## Reporting Bugs

Include:

- OpenClaw version;
- deployment mode;
- browser console errors if any;
- sanitized frame capture if available;
- expected behavior;
- observed behavior.
