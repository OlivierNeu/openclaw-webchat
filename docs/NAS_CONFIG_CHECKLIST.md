# NAS config checklist — outbound file exchange (task #58)

Guarantee the NAS deployment has the configuration that makes the file-exchange
chain (validated locally) work in production. **This is a checklist + commands —
NOT validated by Claude** (the NAS can't be driven from here). Run the ✅ checks
on the NAS. The local proof is `docs/MEDIA_TRANSFER_DESIGN.md` +
`docs/live-evidence-52-codex-fullchain.png`.

## Difference that matters: NAS = codex API mode, local = harness mode
- **Local** reuses `~/.codex` (harness). **NAS** uses codex in **API mode** (its
  own auth). This affects ONLY the model auth — **NOT the media path**: the
  `MEDIA:` directive → outbound-file → `media/outbound/<name>---<uuid>` →
  bridge-reads-via-mount → Convex storage chain is **runtime-agnostic**.
- ⚠️ **ASSUMPTION TO CONFIRM ON NAS (not observed):** that `MEDIA:` surfacing +
  extraction behave identically in API mode. Highly likely (the directive is
  emitted by the agent's reply / tool output, independent of the model runtime),
  but Claude has only ever observed harness-mode surfacing. Confirm with step 4.

## Checklist
1. **Shared media volume mounted READ-ONLY into the bridge** at
   `OPENCLAW_MEDIA_OUTBOUND_DIR` (default `/home/node/.openclaw/media/outbound`),
   backed by the SAME volume every OpenClaw instance writes to (`bridge/docker-compose.yml`
   reference; cf. the NAS `openclaw-olivier` mounts `/volume3/openclaw/instances/olivier/.openclaw`).
   ```bash
   # on the NAS, confirm the bridge container sees agent files:
   docker exec <bridge> ls -l /home/node/.openclaw/media/outbound | tail
   ```
2. **Bridge → Convex is streaming (no base64)** — the bridge ships bytes via the
   Convex upload URL (`getUploadUrl`/`addMediaPart`), so no 20MB ceiling. Confirm
   the bridge image is built from the current `bridge/` (has `core/media-fetcher.ts`
   + the `addMediaBlob`→`getUploadUrl` ops). `CONVEX_HTTP_ACTIONS_URL` points at
   the self-hosted Convex `.site` origin (service name in-compose).
3. **The `write-md-file` skill (or a system instruction) makes agents emit `MEDIA:`**
   — the NAS olivier workspace already has skills; the user noted instructions were
   given to agents to build `MEDIA:` correctly. Without `MEDIA:`, OpenClaw auto-copies
   the file but does NOT surface its path → no attachment (proven locally).
   ```bash
   docker exec openclaw-olivier ls ~/.openclaw/workspace-olivier/skills 2>/dev/null | grep -i media
   ```
4. **End-to-end confirm (the real check):** from the webchat (or a routed user),
   ask the agent to produce a file + attach it → it must render as a downloadable
   attachment whose bytes match. This simultaneously confirms the API-mode `MEDIA:`
   assumption (step's purpose).
5. **Multi-instance**: each tenant has its OWN media dir
   (`/volume3/openclaw/instances/<tenant>/.openclaw/media/outbound`) — NOT one shared dir.
   The bridge serves ONE gateway and binds the MATCHING tenant dir read-only
   (`OPENCLAW_MEDIA_OUTBOUND_HOST_DIR`). To bridge both olivier (:18789) and jerome
   (:18791), run a second bridge or finish the multiplex registry (task #50). See
   `deploy/README.md` "Multi-tenant".
6. **Per-version**: re-run the local `local-openclaw/test-fileexchange.sh <version>`
   on each bump BEFORE promoting the NAS image (catches frame/schema/codex drift).

## NOT done / open
- This checklist is unverified on the NAS (artifacts + commands only).
- API-mode `MEDIA:` surfacing equivalence (step 4) — assumption pending NAS confirmation.
