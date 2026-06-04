# OpenClaw v2026.5.19 — Operator Connection Model (A vs B)

> Decision record for the openclaw-webchat bridge: how the OpenClaw Gateway
> manages operator/node WebSocket connections, and whether the bridge should use
> **one multiplexed connection per instance** (Model A) or **one connection per
> conversation** (Model B, the current code).
>
> Pinned source tag: `v2026.5.19`. All quotes below are verbatim from the **raw**
> docs at `https://raw.githubusercontent.com/openclaw/openclaw/v2026.5.19/docs/`.
> Search-engine prose about OpenClaw has been observed to confabulate
> single-session-per-device "enforcement" with no primary support; it is
> **discarded**. Only primary text is cited here.

---

## TL;DR

- **Recommended model: A — one long-lived operator WebSocket per instance,
  multiplexing many sessions by `sessionKey`.** Confidence: **medium**
  (A-recommendation high; residual unknowns are live-unverified).
- **`multipleConnectionsPerDevice`: `unknown`** on the deciding axis
  (two concurrent **same-role** operator connections sharing one device
  identity). The docs are silent in every assigned gateway page.
- **The unknown threatens Model B, not Model A.** Model A is correct under every
  resolution of the unknown. Model B (the current bridge) is only viable if
  concurrent same-role connections per device are *allowed*; if they are
  forbidden or cause displacement, the current bridge has a latent bug.
- **Security: the Gateway is NOT per-user isolation.** Chat/session frames gate
  on the `operator.read` *scope*, not on user identity. Model A is safe **only
  because the bridge is the trusted demultiplexing point** and MUST enforce
  per-user isolation at the Convex layer. Model B gives **no** isolation benefit
  (each B socket still carries operator scope and can see all sessions it
  subscribes to).

---

## Q1 — Is the connection per-device-multiplexed, or per-conversation?

**Answer: PER-DEVICE, SESSION-MULTIPLEXED (Model A is OpenClaw's native design).**

A connection is a transport that declares a **role + scope** at handshake and
then carries **many sessions** addressed by an in-message `sessionKey`. Sessions
are a *parameter*, not a socket.

Primary evidence — `gateway/protocol.md`
(`https://raw.githubusercontent.com/openclaw/openclaw/v2026.5.19/docs/gateway/protocol.md`):

- > "Each client connection keeps its own per-client sequence number so
  > broadcasts preserve monotonic ordering on that socket even when different
  > clients see different scope-filtered subsets of the event stream."

  One socket carries a scope-filtered stream spanning multiple sessions.

- > "`sessions.subscribe` and `sessions.unsubscribe` toggle session change event
  > subscriptions for the current WS client."
- > "`sessions.messages.subscribe` and `sessions.messages.unsubscribe` toggle
  > transcript/message event subscriptions for one session."

  A single WS client toggles per-session subscriptions — i.e. one socket
  multiplexes many sessions.

- The `sessions.*` RPC family on one connection includes:
  `list, subscribe, unsubscribe, messages.subscribe, messages.unsubscribe,
  preview, describe, resolve, create, send, steer, abort, patch, reset, delete,
  compact, get, usage, usage.timeseries, usage.logs`. All take an explicit
  session target.

Primary evidence — `web/webchat.md`
(`https://raw.githubusercontent.com/openclaw/openclaw/v2026.5.19/docs/web/webchat.md`):

- > "Control UI remembers the backing Gateway `sessionId` returned by
  > `chat.history` and includes it on follow-up `chat.send` calls, so reconnects
  > and page refreshes continue the same stored conversation unless the user
  > starts or resets a session."

  `chat.send` targets a session by an explicit `sessionId` parameter — the
  conversation is addressed *in the message*, not by socket identity.

**Note (honesty):** `protocol.md` does not contain a sentence that *literally*
says "a connection is per-device, not per-conversation." The per-device-
multiplexed conclusion is the only reading consistent with (a) per-client
sequence numbers, (b) per-session subscribe toggles on one WS client, and
(c) `chat.send` carrying a `sessionId`. There is no per-conversation connection
construct anywhere in the docs.

---

## Q2 — Can multiple concurrent connections share the SAME device identity? (THE DECIDER)

**Answer: `unknown` on the deciding axis. This is the single blocker fact and is
live-only.**

The decider for A-vs-B is specifically: **two concurrent OPERATOR-role
connections sharing ONE device identity.** On that exact axis the docs are
silent.

What the docs DO say (verbatim) — and why it is *not* the decider:

- **Cross-role concurrency is explicitly tolerated** (`protocol.md`):
  > "Presence entries include `deviceId`, `roles`, and `scopes` so UIs can show
  > a single row per device even when it connects as both operator and node."

  So one device identity demonstrably holds ≥2 concurrent connections — but as
  **operator + node**, a *different* role pair. This does not establish that
  **operator + operator** is allowed.

- **No single-live-connection / "device already connected" rule exists.** Across
  the assigned gateway docs there is no rejection-on-duplicate or
  displacement rule:
  - `gateway/protocol.md`: ABSENT (no concurrency/uniqueness rule).
  - `gateway/pairing.md`: ABSENT (no "already connected"/displacement logic).
  - `gateway/trusted-proxy-auth.md`: SILENT on concurrency (proxy header/identity
    forwarding only).

- **Handshake separates durable identity from per-connection identity**
  (`protocol.md`): the connect request carries a durable
  `device: { "id": "device_fingerprint", "publicKey": "…", "signature": "…",
  "signedAt": …, "nonce": "…" }`, and the gateway response carries a
  per-connection `server: { "version": "…", "connId": "…" }`. The presence of a
  distinct `connId` per connection is consistent with multiple connections per
  `device.id`, but does not *prove* same-role concurrency is accepted.

**Resolution: `unknown`.** Calling this "allowed" would overclaim on the precise
axis (same-role) that is undocumented; the only verbatim concurrency evidence is
cross-role. Calling it "forbidden" is unsupported (no rule exists). Honest value:
**unknown** — must be confirmed by the live test below.

---

## Q3 — How are sessions identified/addressed, and the sessionKey grammar?

**Answer: addressed by an explicit `sessionKey`/`sessionId` parameter on one
connection. Documented grammar is the `agent:` form; the bridge-fixture
`webchat:chat:…` form is NOT in the docs.**

Documented grammar — `concepts/multi-agent.md`
(`https://raw.githubusercontent.com/openclaw/openclaw/v2026.5.19/docs/concepts/multi-agent.md`):

- Single-agent default:
  > "Sessions are keyed as `agent:main:<mainKey>`."
- Multi-agent direct chats:
  > "Direct chats collapse to `agent:<agentId>:<mainKey>` (per-agent \"main\";
  > `session.mainKey`)."
- > "`agentId`: one \"brain\" (workspace, per-agent auth, per-agent session
  > store)."

Addressing & lifecycle:
- `chat.send` targets the conversation via the backing Gateway `sessionId`
  remembered from `chat.history` (`web/webchat.md`, quoted in Q1).
- Full lifecycle RPCs exist on one connection:
  `sessions.create / list / describe / resolve / send / steer / abort / patch /
  reset / delete / compact / get` (`protocol.md`).

**Residual (NOT FOUND):** the bridge-fixture form
`agent:<agentId>:webchat:chat:<canonical>:<chatId>` is **not present verbatim**
in any v2026.5.19 doc read. `protocol.md` uses `sessionKey` as an opaque
parameter without defining its grammar (sessionKey grammar = ABSENT there);
`multi-agent.md` documents only `agent:main:<mainKey>` and
`agent:<agentId>:<mainKey>` (WEBCHAT FORM ABSENT). `<mainKey>` is left opaque and
never expanded to a webchat-specific form. Treat the `webchat:chat:…` segment as
a residual to capture empirically (live test step 4).

---

## Q4 — Does the OPERATOR role inherently observe ALL sessions over one connection?

**Answer: YES — observation is gated by SCOPE, not per-user identity. This is the
multiplexing mechanism, and the security hazard.**

Primary evidence — `gateway/protocol.md` (Broadcast event scoping):
- > "Server-pushed WebSocket broadcast events are scope-gated so that
  > pairing-scoped or node-only sessions do not passively receive session
  > content."
- > "Chat, agent, and tool-result frames … require at least `operator.read`."
- > "Status and transport events (`heartbeat`, `presence`, `tick`,
  > connect/disconnect lifecycle, etc.) remain unrestricted."
- > "Unknown broadcast event families are scope-gated by default (fail-closed)."

Primary evidence — `gateway/operator-scopes.md`
(`https://raw.githubusercontent.com/openclaw/openclaw/v2026.5.19/docs/gateway/operator-scopes.md`):
- `operator.read` = > "Read-only status, lists, catalog, logs, session reads, and
  other non-mutating control-plane calls."
- `operator.write` = > "Normal mutating operator actions such as sending
  messages, invoking tools … Also satisfies `operator.read`."
- `operator.admin` = > "Administrative control-plane access. Satisfies every
  `operator.*` scope. …"

So a single `operator.read` connection receives chat/agent/tool frames and can
`sessions.list`/read for every session it subscribes to. Visibility is gated by
**scope**, not by which human user is behind the socket.

**Security consequence (load-bearing).** `operator-scopes.md`:
- > "They are a control-plane guardrail inside one trusted Gateway operator
  > domain, not hostile multi-tenant isolation."
- > "If you need strong separation between people, teams, or machines, run
  > separate Gateways under separate OS users or hosts."

(Note: `operator-scopes.md` also says non-admin token sessions are self-scoped —
> "non-admin callers see only their own pairing entries, can approve or reject
> only their own pending request, and can rotate, revoke, or remove only their
> own device entry." This is **pairing-record management** visibility, a
> different axis; it does **not** isolate chat/session *content*.)

**Implication for the bridge:** under Model A, one operator socket can see all
subscribed sessions. The bridge is the **trusted demux point** and MUST enforce
per-user isolation in Convex — the Gateway will not. Model B does **not** fix
this: each per-conversation socket still authenticates with operator scope and
can observe any session it subscribes to, so B is not "safer." Real cross-user
isolation requires separate Gateways, per `operator-scopes.md`.

---

## Q5 — Pairing model and (re)connect handshake

**Answer: pairing is durable PER DEVICE; reconnect uses the issued token (not a
re-pair); re-pair only rotates the token.**

Primary evidence — `gateway/pairing.md`
(`https://raw.githubusercontent.com/openclaw/openclaw/v2026.5.19/docs/gateway/pairing.md`):
- > "On approval, the Gateway issues a new token (tokens are rotated on
  > re-pair)."
- > "Approval always generates a fresh token; no token is ever returned from
  > `node.pair.request`."
- > "The node reconnects using the token and is now \"paired\"."
- > "`node.pair.request` is idempotent per node: repeated calls return the same
  > pending request."
- Storage: > "Pairing state is stored under the Gateway state directory (default
  > `~/.openclaw`): `~/.openclaw/nodes/paired.json`."

Connect handshake — `gateway/protocol.md`:
- > "Nodes should include a stable device identity (`device.id`) derived from a
  > keypair fingerprint."
- > "All connections must sign the server-provided `connect.challenge` nonce."
- Connect request device block:
  `device: { "id": "device_fingerprint", "publicKey": "…", "signature": "…",
  "signedAt": 1737264000000, "nonce": "…" }`.
- Gateway reply carries `server: { "version": "…", "connId": "…" }`.

So the device identity (keypair fingerprint + per-device/role token) is the
durable connection identity; a fresh socket signs the challenge nonce with the
device key and presents the stored token. Re-pairing is only needed to rotate
the token or broaden role/scope.

---

## Recommendation: Model A (per-instance, multiplexed)

**Pick A — one long-lived operator WebSocket per instance, multiplexing sessions
by `sessionKey`.**

Why A is robust under *every* resolution of the open unknown:
1. A is OpenClaw's **native** design — one role-scoped socket, `sessions.*` +
   `chat.send` targeting an explicit session (Q1, Q3, Q4).
2. A needs only **one** connection per device identity → it never trips any
   (undocumented) same-role concurrency limit (Q2).
3. The current bridge does **B** (N sockets, same device identity). If the
   Gateway forbids or **displaces** a second same-role connection, then opening
   chat #2 either errors or silently kills chat #1 — a latent bug in today's
   code. The unknown is a risk to B, not to A.

**Hard requirement attached to A (security):** the bridge MUST enforce per-user
isolation in Convex (each Convex user only ever sees their own chat's frames),
because the Gateway gates on the `operator.read` scope, not on user identity
(Q4). Do not treat the single operator socket as a tenant boundary.

`recommendedModel = A_per_instance_multiplex` · `confidence = medium` ·
`multipleConnectionsPerDevice = unknown`.

---

## Minimal LIVE TEST to confirm empirically

Goal: empirically resolve (T1) that one socket multiplexes ≥2 sessions, and (T2)
the decider — what happens when a second **same-role** operator connection uses
the **same device identity**. Also (T4) capture the real webchat `sessionKey`.

### Inputs / secrets required
- Gateway WebSocket URL (e.g. `ws://<host>:<port>/...` for the local instance).
- A **paired** `device.id` (keypair fingerprint) **and its private signing key**
  — needed to sign the `connect.challenge` nonce.
- A valid **operator `auth.token`** for that device+role (`operator.read` is
  enough to observe; `operator.write` to send).
- Two distinct conversations to target (two `sessionKey`s, or create them via
  `sessions.create` / start two webchats).
- A WS client that can: send the first `connect` req, sign the challenge, then
  issue `sessions.subscribe` / `sessions.messages.subscribe` and `chat.send`.

### T1 — Confirm one socket multiplexes many sessions (proves A works)
1. Open **one** operator WS. Send `connect` req; on `connect.challenge`, reply
   signing the nonce with the device key + `auth.token`, role `operator`.
   Expect `hello-ok` with `server.connId`.
2. `sessions.create` (or open) **two** sessions; capture both returned
   `sessionId`/`sessionKey`.
3. `sessions.messages.subscribe` for **both** sessions on this one socket.
4. `chat.send` into session #1, then into session #2.
5. **Expected (A confirmed):** both sessions' transcript/agent frames stream back
   on the **single** socket, each tagged to its own session, with monotonic
   per-client `seq`. If true, A is empirically viable.

### T2 — The DECIDER: second same-role connection, same device identity
1. Keep the T1 socket open and active.
2. Open a **second** WS. Send `connect` with the **same** `device.id`, sign the
   new challenge with the **same** key, present an operator token, role
   `operator` (same role as socket #1).
3. Observe which of **three** outcomes occurs:
   - **(a) Both accepted in parallel** (socket #1 keeps streaming, socket #2 also
     gets `hello-ok` and can subscribe) → `multipleConnectionsPerDevice = allowed`
     → **Model B is viable** (though still no isolation benefit).
   - **(b) Second rejected** (error such as "device already connected" /
     duplicate) → **forbidden** → **Model B is broken**; use A.
   - **(c) First silently displaced** (socket #1 stops receiving frames / is
     closed when #2 connects) → **forbidden-in-effect** → **Model B is broken**
     and the *current bridge has the bug*; use A. **This (c) is the easy-to-miss
     outcome — watch socket #1 explicitly after #2 connects.**
4. Record exact error codes/close frames for (b)/(c).

### T3 — (Optional) cross-role sanity check
Connect socket #1 as `operator` and a second as `node` with the same `device.id`
(the verbatim-tolerated case per `protocol.md` presence). Expect both to coexist
and presence to show a single device row with `roles: [operator, node]`.
Confirms the docs' cross-role statement and isolates that T2's result is about
the **same-role** axis specifically.

### T4 — Capture the real webchat sessionKey grammar
On the T1 sessions (open via the actual WebChat flow if possible), log the exact
`sessionKey` the Gateway returns. Compare against documented
`agent:<agentId>:<mainKey>` vs the bridge fixture
`agent:<agentId>:webchat:chat:<canonical>:<chatId>`. Resolves the Q3 residual.

### Pass/fail decision
- T1 streams both sessions on one socket → **A is implementable today.**
- T2 = (a) → B remains technically viable, but A is still recommended (simpler,
  no isolation cost). T2 = (b) or (c) → **B is unsafe; migrate the bridge to A.**

---

## Open unknowns (named, residual)

1. **DECIDER:** Whether two concurrent **same-role** operator connections may
   share one `device.id` (accepted in parallel / rejected / displaces the
   existing one). ABSENT in `protocol.md`, `pairing.md`; SILENT in
   `trusted-proxy-auth.md`. Live-only (test T2).
2. **Webchat sessionKey grammar:** the fixture form
   `agent:<agentId>:webchat:chat:<canonical>:<chatId>` is NOT in v2026.5.19 docs;
   only `agent:main:<mainKey>` / `agent:<agentId>:<mainKey>` are documented. Live
   capture (test T4).
3. **Per-device concurrent-connection limit / count:** no maximum stated
   anywhere. Cross-role (operator+node) coexistence is verbatim; any numeric cap
   is undocumented.

---

## Sources & confidence

All raw, pinned at tag `v2026.5.19`, verified firsthand for this doc:

- `gateway/protocol.md` —
  `https://raw.githubusercontent.com/openclaw/openclaw/v2026.5.19/docs/gateway/protocol.md`
  (handshake, connId, per-client seq, scope-gated broadcast, `sessions.*`,
  presence operator+node). **Load-bearing for Q1/Q2/Q4/Q5.**
- `gateway/pairing.md` —
  `https://raw.githubusercontent.com/openclaw/openclaw/v2026.5.19/docs/gateway/pairing.md`
  (token rotation on re-pair, idempotent pair request, `paired.json`; ABSENT on
  concurrency). **Q5; Q2 ABSENT.**
- `gateway/operator-scopes.md` —
  `https://raw.githubusercontent.com/openclaw/openclaw/v2026.5.19/docs/gateway/operator-scopes.md`
  (read/write/admin defs; NOT multi-tenant isolation; self-scoped pairing
  records). **Q4 + security.**
- `gateway/trusted-proxy-auth.md` —
  `https://raw.githubusercontent.com/openclaw/openclaw/v2026.5.19/docs/gateway/trusted-proxy-auth.md`
  (proxy identity forwarding; SILENT on connection concurrency). **Q2 SILENT.**
- `concepts/multi-agent.md` —
  `https://raw.githubusercontent.com/openclaw/openclaw/v2026.5.19/docs/concepts/multi-agent.md`
  (`agent:main:<mainKey>`, `agent:<agentId>:<mainKey>`; WEBCHAT FORM ABSENT).
  **Q3.**
- `web/webchat.md` —
  `https://raw.githubusercontent.com/openclaw/openclaw/v2026.5.19/docs/web/webchat.md`
  (UI remembers `sessionId`, sends it on `chat.send`). **Q1/Q3.**
- DISCARDED: search-engine/blog prose asserting "single-connection-per-device
  enforcement" — no primary support; confabulated.

**Confidence: medium.** The A recommendation is **high** confidence (robust under
every resolution of the unknown; native design). The residuals — the same-role
concurrency decider and the webchat sessionKey form — are **live-unverified**,
hence the overall medium. This is "reliable enough to START live-verifying": run
tests T1–T4, with the same-role concurrency outcome (T2 a/b/c) being the one fact
that flips B from viable to broken.
