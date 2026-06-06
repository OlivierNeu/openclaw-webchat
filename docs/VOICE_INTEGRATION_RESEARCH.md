# Voice integration research — TTS, Talk (STS), Voice wake

Research for wiring OpenClaw voice tooling into openclaw-webchat (Settings ›
Intégrations). Done 2026-06-06. The OpenClaw docs are real + detailed; community
content exists (LumaDock, Meta-Intelligence, learnopenclaw, Panaversity, a GitHub
feature issue). Project principle still applies: **fixtures win over public docs**
— there are NO bridge fixtures for tts/talk yet, so the Convex config shape is
deliberately minimal/flat until the gateway protocol is pinned.

## TTS (text-to-speech) — https://docs.openclaw.ai/tools/tts
- Configured in `~/.openclaw/openclaw.json` under `messages.tts` (auto mode,
  provider, deep `providers`/`personas`/`modelOverrides` tree). 14 providers
  (OpenAI, ElevenLabs, Azure, Google, Microsoft no-key, MiniMax, xAI, …). Keys via
  per-provider ENV vars.
- Runtime control = **gateway RPC**: `tts.status/enable/disable/convert/
  setProvider/setPersona/providers` + slash commands + `[[tts:…]]` directives.
- **Wiring into our webchat:** the provider-key config is OPS-owned (openclaw.json
  + env) and our Convex can't own it. What our webchat CAN drive is the **RPC
  runtime surface** (enable/disable/provider/persona) via the bridge, + store the
  non-secret defaults (auto/provider/model/voice/persona) for the bridge to apply.
  Consumer = the bridge (not built) → form labeled "appliqué par le bridge (à venir)".

## Talk mode / STS (speech-to-speech) — https://docs.openclaw.ai/nodes/talk
- Configured under `talk` + `talk.realtime`. Realtime provider = OpenAI
  `gpt-realtime-2` (voices cedar/marin recommended) or Google. Transports:
  **webrtc** (browser, client-owned sessions), provider-websocket, gateway-relay.
  Knobs: speechLocale, silenceTimeoutMs, interruptOnSpeech.
- **Wireable into our webchat: YES** — browser WebRTC realtime is explicitly
  supported ("browser realtime with client-owned sessions"). BUT the
  security-critical piece: the browser must use a **server-minted EPHEMERAL
  session token** — the raw `OPENAI_API_KEY` must NEVER reach the client. So the
  wiring = bridge/Convex action mints an ephemeral token (using the env key) →
  browser opens the WebRTC session with that short-lived token. This is a real,
  sizable frontend+bridge feature (not built); the form stores the non-secret
  realtime knobs ready for it.

## Voice wake — https://docs.openclaw.ai/nodes/voicewake
- Gateway-server function + **native wake-word detection on macOS/iOS**; Android =
  manual mic; **browser is NOT a supported platform**. RPC: `voicewake.get/set` +
  `voicewake.routing.get/set`.
- **Wiring into our webchat: NOT natively possible.** A browser has no native
  wake-word engine; doing it would require shipping a client-side engine (e.g.
  Picovoice Porcupine WASM) we build ourselves — outside OpenClaw. Decision: NOT
  built; surfaced as an info note in the Intégrations tab. The gateway triggers can
  still be configured via `voicewake.*` RPC if a paired native node exists.

## What was built (this increment)
Settings › Intégrations now has config forms (admin, NON-SECRET only; keys stay in
env, shown as a `configured` indicator): **Langfuse** (host + enabled — LIVE, real
consumer = trace shipper), **Opik** (baseUrl + workspace + enabled — LIVE), **TTS**
(auto/provider/model/voice — bridge-pending), **Talk** (enabled/realtime provider/
model/voice/transport/locale/interrupt — bridge-pending), **Voice wake** (info
note). Backend: `integrationConfig` singleton + `integrations/config.ts`
precedence Convex→env→default + `admin.setIntegrationConfig`.

## Sources
- [OpenClaw TTS](https://docs.openclaw.ai/tools/tts)
- [OpenClaw Talk mode](https://docs.openclaw.ai/nodes/talk)
- [OpenClaw Voice wake](https://docs.openclaw.ai/nodes/voicewake)
- [LumaDock — Add voice with TTS/STT/Talk Mode](https://lumadock.com/tutorials/openclaw-voice-tts-stt-talk-mode)
- [Meta-Intelligence — OpenClaw + Whisper + ElevenLabs](https://www.meta-intelligence.tech/en/insight-openclaw-voice)
- [Medium — OpenClaw and Voice AI (Gustavo Garcia)](https://medium.com/@ggarciabernardo/openclaw-and-voice-ai-ee3ce4fffcea)
- [learnopenclaw — Voice & Talk Mode](https://learnopenclaw.com/advanced/voice)
- [Panaversity — Give It a Voice](https://agentfactory.panaversity.org/docs/Building-OpenClaw-Apps/meet-your-personal-ai-employee/give-it-a-voice)
- [GitHub issue #49246 — Verbal dialogue (STT/TTS)](https://github.com/openclaw/openclaw/issues/49246)
