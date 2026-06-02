# Development Guide

## Backend Setup

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements-dev.txt   # runtime deps + pytest + pytest-asyncio
```

Run tests (pytest config lives in `backend/pyproject.toml`, `asyncio_mode = auto`):

```bash
cd backend
pytest -q
```

The normalizer regression suite (`tests/test_normalizer.py`) imports only the
sanitizer (stdlib only), so it runs with nothing but `pytest` installed — useful
when the heavier app dependencies (FastAPI, firebase-admin) are unavailable:

```bash
cd backend
pip install pytest && pytest -q tests/test_normalizer.py
```

Run backend:

```bash
cd backend
source .venv/bin/activate
export OPENCLAW_WEBCHAT_CONFIG_FILE="$PWD/../config.local.json"
export ALLOW_DEV_AUTH=true
export OPENCLAW_MEDIA_LINK_SECRET="dev-secret"
uvicorn app.main:app --reload --port 8080
```

## Frontend Setup

```bash
cd frontend
npm install
cp .env.example .env.local
npm run dev
```

Type-check, test and build:

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run build       # tsc && vite build
```

## Quality Gates

Before opening a pull request:

```bash
cd backend
pip install -r requirements-dev.txt
python -m py_compile app/*.py tests/*.py
pytest -q

cd ../frontend
npm run typecheck
npm test
npm run build
```

## Frame Capture and Regression Testing

The bridge's correctness depends on real OpenClaw frame shapes, which differ by
version and carry hard-won edge cases. The regression suite is built from
**captured real frames**, not invented ones.

- Fixtures live in `backend/tests/fixtures/openclaw_frames.json`, keyed by
  scenario, each holding the exact raw frame(s) the Gateway emits and a note on
  the required behaviour. The `.gitignore` keeps `*.ndjson` / `*.log` out of the
  repo *except* under `backend/tests/fixtures/`, so captured NDJSON traces can
  be committed as fixtures.
- `tests/test_normalizer.py` replays these fixtures through the normalizer with
  an **injected clock** (no real time, no event loop), so grace windows
  (empty-final, private-ack, lifecycle-end, compaction) are deterministic.
- To capture new frames, enable the bridge/Gateway frame probe, save the raw
  NDJSON under `backend/tests/fixtures/`, add a scenario, then extend the
  normalizer until the new fixture passes. The browser-facing contract should
  not change.

When a regression is found, add the failing capture as a fixture first, then
fix the normalizer — the contract events stay stable.

## Adding New Frontends

New frontends should start from `docs/BRIDGE_PROTOCOL.md` and consume the
**normalized** events (`message.delta`/`snapshot`/`final`, `run.status`,
`tool.status`, `media`). They should not depend on the deprecated raw
`openclaw.frame` passthrough.

If a frontend needs a new stable field, add it to the bridge protocol and write
a backend test first.
