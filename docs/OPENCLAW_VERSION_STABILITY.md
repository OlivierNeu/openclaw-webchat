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
| **2026.5.19** | 0.133.0 | **required** (flag bug) | ✅ | ⚠️ **was PASS, now ALL SENDS FAIL** (2026-06-05 pm, see log) | **8/8 complete, 0 err** (2026-06-05 am) — but UNREPRODUCIBLE now (sends broken) | reorder wrapper for the codex flag bug; **OPEN/UNRESOLVED: every send (text AND attachment) on a freshly reset 5.19 container returns `unauthorized: gateway token mismatch (set gateway.remote.token to match gateway.auth.token)` even though all 5 token values hash-match — root cause NOT isolated; CONTRADICTS the earlier same-day PASS** | ⚠️ **trust DOWNGRADED** — cannot currently send on a clean 5.19 harness |
| **2026.6.1** | 0.137.0 | not needed (native fix) | ✅ | ✅ PASS¹ | **8/8 complete, 0 err** (2026-06-05) | none from the agent itself; BUT see ¹ — a fresh `reset → up 6.1` ALSO can't send (same harness bring-up break as 5.19) | candidate bump — agent stable; **harness bring-up currently broken** |

> ¹ **HARNESS BRING-UP REGRESSION (version-independent), 2026-06-05 pm.** The `smoke PASS` / `8/8` /
> #59 "Rouge" results above were obtained on gateway containers brought up **earlier** (and, for the
> pre-session 6.1 container, with a device already paired at full scope). A **fresh** `reset → up
> <version> → pair.sh → bridge restart` — tried on BOTH 5.19 and 6.1 today — yields a gateway that
> rejects every send with `unauthorized: gateway token mismatch (set gateway.remote.token to match
> gateway.auth.token)` despite all token values hash-matching. This is a **harness** problem, not a
> per-version trust signal. See the newest observations-log entry. Do not promote either version off
> these numbers until a clean bring-up can send again.

## Observations log (newest first)
- **2026-06-05 (pm) — ⚠️ 5.19 SENDS BROKEN on a freshly reset container; root cause
  NOT isolated; CONTRADICTS the earlier same-day 5.19 PASS.** While re-running the
  #59 inbound round-trip on 5.19 (reset → `OPENCLAW_VERSION=2026.5.19 up.sh` →
  re-pair → bridge restart with the new token), **every** `bridge /send` — both the
  image-attachment turn AND a plain text-only `dev.testSend` — failed with
  `INVALID_REQUEST: unauthorized: gateway token mismatch (set gateway.remote.token
  to match gateway.auth.token)`. Evidence gathered:
  - **All five token values hash-match** (sha256 prefix `dc0ece750a7f`): harness
    `.token`, bridge `OPENCLAW_TOKEN`, container env `OPENCLAW_GATEWAY_TOKEN`, and
    the (hand-patched) `gateway.auth.token` + `gateway.remote.token` in the live
    config. → the error text is **misleading**; this is not a literal value
    mismatch.
  - **Hand-patching** `gateway.remote.token = gateway.auth.token = <run token>` in
    the live `openclaw.json` + restart did **NOT** fix it.
  - The gateway log shows a device pairing as `operator.pairing` then a connect
    requesting a scope upgrade to `operator.admin` → `connect failed (1008)` — BUT
    those lines are **pre-restart** and one is `peer=127.0.0.1` (pair.sh's
    deliberate throwaway connect, designed to fail), so this is a **hypothesis, NOT
    a confirmed cause**; the gateway-side line for the actual failing send was not
    captured.
  - **Text-only fails too** → not attachment-specific and **NOT a defect in the #59
    dispatch code** (version-agnostic Convex, PROVEN end-to-end on 6.1: red-square →
    agent replied "Rouge", outbox `sent`).
  - **⚠️ NOT VERSION-SPECIFIC — it's the HARNESS BRING-UP FLOW.** Correction to the
    first read of this entry: after seeing 5.19 fail, I `reset` + `up 2026.6.1` via
    the **same** `up.sh`/`pair.sh` and a text-only send **failed identically** with
    the same `gateway token mismatch`. So **both** 5.19 and 6.1, when brought up
    fresh THIS way, are broken for sends. The earlier "Rouge" #59 proof + the
    `8/8`/`smoke PASS` numbers were on a 6.1 container started **before this session**
    (different bring-up conditions, device already paired with full scope in its
    persisted state) — those results are **not reproducible via the current
    `reset → up → pair.sh → bridge-restart` cycle**. Whether they "still stand" is
    NOT yet decided (see regression lead below): if a harness script changed since
    that green run, the numbers may be a REGRESSION; if nothing changed, they may
    have been FLAWED. Do not quote them as trustworthy until #61 discriminates.
  - **REGRESSION LEAD (the cheap discriminator, partially run):** the harness was
    committed at **`f7d2a5e` (2026-06-05 18:20)** ("Add new Docker setup and enhance
    file exchange system") AND `local-openclaw/up.sh` has an **uncommitted edit**
    (this session's media/inbound EACCES `chown`). The working 6.1 container was up
    ~18:13 — i.e. **before** that 18:20 commit; the broken `reset → up` runs (18:49+)
    used the post-`f7d2a5e` scripts. So a harness-change regression is the prime
    suspect → **#61 first step: `git show f7d2a5e -- local-openclaw/` + diff the
    uncommitted up.sh** to see if token/pairing/scope handling changed at that
    boundary. (Not done here — that's the #61 deep-dive.)
  - **Leading hypothesis (NOT yet confirmed):** the gateway log shows the bridge
    device auto-approved as `role=operator scopes=operator.pairing`, then a connect
    requesting a scope **upgrade to `operator.admin`** → `connect failed (1008)`.
    i.e. `pair.sh`'s `devices approve` grants only *pairing* scope, but a send needs
    *admin* scope, and the upgrade is refused — surfaced (misleadingly) as a "token
    mismatch". A container whose device was paired *before* the volume was reset
    retains admin scope and works; a freshly re-paired device does not. **Still a
    hypothesis** — the gateway-side log line for the actual failing send was not
    captured; needs confirmation.
  - **Status:** #59 stays open on 5.19 (proven on 6.1 only). **The harness itself is
    the blocker, version-independent** — it needs a dedicated debugging pass:
    capture the gateway-side log of the *actual* failing send, confirm/deny the
    device-scope hypothesis, and fix `pair.sh` to grant the scope a send requires
    (or set the device role/token correctly) so a clean `reset → up` yields a
    sendable gateway again. Until then, live-agent verification must use a gateway
    container that has NOT been reset this session.
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
