# OpenClaw version stability ledger

The basis for **trusting (or not) an OpenClaw version before promoting it** to the
NAS. Tracks, per version: required config, known issues, observed stability,
fixes, and irritations. Append on every version bump.

## Methodology
- **Smoke test** — `local-openclaw/test-fileexchange.sh <version>`: functional
  correctness of the outbound file chain (1 media part, byte-exact, no dead link).
- **Stability test** — `local-openclaw/test-stability.sh <version> <N>`: N codex
  file-creation turns, tallies each turn's terminal outcome:
  - `complete` — turn finalized clean.
  - `error` — the attachment WAS produced but the turn finalized `error`
    (e.g. `codex app-server client closed before turn completed`).
  - `no-attach` — no attachment within the poll window (turn failed / lost).
- **Environment caveat (load-bearing):** local runs are **emulated amd64 on
  arm64** (Docker Desktop, Mac) in **codex harness** mode (ChatGPT Pro). The
  emulation adds latency/instability. So:
  - the **RELATIVE** comparison between versions (same emulation) IS trustworthy;
  - the **ABSOLUTE** error rate may be HIGHER than the NAS (native amd64, codex
    API mode). Re-measure trends, not just single numbers.

## Per-version ledger

| Version | codex CLI | Reorder wrapper | Seed valid | Smoke | Stability (N turns) | Known issues / irritations | Trust |
|---|---|---|---|---|---|---|---|
| **2026.5.19** | 0.133.0 | **required** (flag bug) | ✅ | ✅ PASS | **8/8 complete, 0 err** (2026-06-05) | `--dangerously-bypass-approvals-and-sandbox` passed after `app-server` → needs reorder wrapper; `codex app-server client closed before turn completed` seen **ONCE** but **NOT reproduced** in 8 controlled turns → intermittent anomaly, not a confirmed defect | current prod baseline — stable in test |
| **2026.6.1** | 0.137.0 | not needed (native fix) | ✅ | ✅ PASS | **8/8 complete, 0 err** (2026-06-05) | none observed (codex flag bug natively fixed) | candidate bump — stable in test |

## Observations log (newest first)
- **2026-06-05 — stability run (test-stability.sh, 8 turns/version, turn-STATUS
  metric):** `2026.5.19 → 8/8 complete, 0 error, 0 timeout`; `2026.6.1 → 8/8
  complete, 0 error, 0 timeout`. **Both versions fully stable in this run.** The
  `codex app-server client closed` error seen earlier (below) did NOT recur → it
  was a **single intermittent anomaly**, not a reproducible per-version defect.
  Methodology note: the first stability draft measured *attachment presence*,
  which conflated app-server stability with the agent's inconsistent `MEDIA:`
  emission (codex sometimes omits the directive even when prompted — a separate
  reliability axis worth its own metric); switched to **turn terminal status**
  (`dev.chatStats`) which isolates app-server stability. Caveat: emulated env.
- **2026-06-05** — During the both-version smoke run: the **5.19** turn finalized
  `error` (`codex app-server client closed before turn completed`) AFTER producing
  the attachment (the media part rendered; status went error). The **6.1** turn in
  the same run finalized `complete`. Single observation each — not yet a rate.
  Plausibly tied to 5.19's codex 0.133 + the reorder-wrapper path; 6.1 (codex
  0.137 + native flag fix) was clean. → a point in favour of the 6.1 bump, pending
  the repeated stability test.

## How to read it for a promotion decision
1. Smoke = PASS on the target version (functional correctness).
2. Stability error rate ≤ the current baseline (or better) — RELATIVE to the same
   emulated env. Investigate any NEW irritation class.
3. Config deltas (wrapper/seed) handled by the version-agnostic harness
   (docs/OPENCLAW_VERSION_COMPAT.md).
4. Confirm on the NAS (native, API mode) before promoting — the local env is a
   pre-filter, not the final word.
