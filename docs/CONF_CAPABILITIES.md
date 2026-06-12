# CONF-2 — Capacités configurables OpenClaw 2026.6.5 → mapping webchat

> Source : documentation officielle embarquée dans l'image 2026.6.5
> (`/app/docs`, 672 fichiers, extraite et ratissée le 2026-06-11). Chaque fait
> cite son fichier. Principe directeur (Olivier) : **ne perdre aucune capacité
> d'OpenClaw**. Fondation design : `CONF_RESEARCH.md`.

## 1. La découverte clé : `sessions.patch` est bien plus riche que notre UI-3

Champs patchables par session (`operator.write`, hot-apply, persiste jusqu'au
reset) — source `reference/session-management-compaction.md` + `tools/thinking.md` :

| Champ | Valeurs | Statut webchat |
|---|---|---|
| `thinkingLevel` | off/minimal/low/medium/high/xhigh (+adaptive/max selon provider) | ✅ déjà (UI-3) |
| `modelOverride` | `provider/model` | ✅ déjà (UI-3) |
| `verboseLevel` | off/on/full | ✅ déjà (fixé full pour le streaming) |
| **`fastMode`** | true/false — c'est le « SPEED » du Control UI (OpenAI `serviceTier: priority`) | ❌ à exposer |
| **`reasoningLevel`** | off/on/stream — visibilité du raisonnement | ❌ à exposer |
| **`elevatedLevel`** | off/on/ask/full | ❌ à exposer (évaluer pertinence) |
| `providerOverride` / `authProfileOverride` | provider / profil oauth | ❌ admin-only si exposé |
| `label` | libellé de session | ❌ (on a déjà nos titres de chat) |
| `sendPolicy` | routage de livraison par session | ❌ avancé, plus tard |

**Cascade de résolution documentée** (ex. thinking) : directive inline → session
override → défaut per-agent → défaut global → provider. → Notre badge
« héritée » est exactement le bon modèle ; à généraliser à chaque champ
(pattern VS Code barre-de-provenance, cf. CONF_RESEARCH).

## 2. Workspace files : RPC officiels (la feature que veut Olivier)

`agents.files.list(agentId)` / `agents.files.get` / `agents.files.set`
(« bootstrap files », scope admin pour set) — source `gateway/protocol.md` §agents.

| Fichier | Rôle (doc `concepts/agent-workspace.md`) |
|---|---|
| AGENTS.md | règles opérationnelles | 
| SOUL.md | persona, ton, limites |
| USER.md | qui est l'utilisateur |
| IDENTITY.md | nom/emoji de l'agent |
| TOOLS.md | conventions d'outils (guidance) |
| HEARTBEAT.md | checklist heartbeat (court) |
| MEMORY.md | mémoire long-terme curée |
| BOOT.md / BOOTSTRAP.md | démarrage / premier run |

Limites à afficher dans l'UI : `bootstrapMaxChars` 20 000/fichier,
`bootstrapTotalMaxChars` 60 000 total (le doctor du NAS a déjà signalé
MEMORY.md à 86 %) — un **gauge par fichier** est une vraie valeur ajoutée.
⚠️ `agents.files.*` = fichiers plats seulement (pas `memory/YYYY-MM-DD.md`).

## 3. Talk/voice : la réponse à « peut-on configurer le transport ? » = OUI

Surface RPC complète (source `nodes/talk.md` + `gateway/protocol.md`) :
- **Client-owned** (notre cas webchat) : `talk.client.create({transport:
  "webrtc"|"provider-websocket"})`, `talk.client.steer`, `talk.client.toolCall`.
- **Gateway-owned** : `talk.session.create({mode: realtime|transcription|
  stt-tts, transport: "gateway-relay", brain: agent-consult|direct-tools|none})`
  + appendAudio/startTurn/endTurn/steer/close.
- **Découverte sans secrets** : `talk.catalog` (providers, voix, modes,
  transports, formats) ; `talk.config` (effectif ; secrets gated
  `operator.talk.secrets`).
- **TTS** : `tts.status/providers/enable/disable/setProvider/convert`.
- Défauts globaux dans `talk.*` de openclaw.json (provider, voice,
  silenceTimeoutMs, interruptOnSpeech, realtime.transport/mode/brain,
  consultThinkingLevel/consultFastMode).

→ Le panneau voice du Control UI (Provider/Transport/VAD/Pause/Lead-in) est
pilotable par un client externe. **Pré-requis** : câbler le mode Talk dans le
webchat (gap connu #75) — le design CONF-3 réserve la section, l'implémentation
voice est un chantier séparé.

## 4. Config gateway à chaud (défauts admin)

`config.get` / `config.patch` (merge partiel) / `config.set` / **`config.schema`
(JSON Schema live + hints UI !)** — scope `operator.admin`, hot-apply partiel
(plugins/auth/channels → restart). Source `gateway/protocol.md` §config.
→ Un onglet Settings admin « Défauts d'agent » peut éditer
`agents.defaults.thinkingDefault`, `fastModeDefault`, etc. de façon SCHÉMA-PILOTÉE
(le schéma vient du gateway, zéro hardcode par version). Et `models.list`
(`view: configured|all|default`) remplace avantageusement notre liste statique.

## 5. Autres surfaces notables (capability cookbook)
- `sessions.usage`, `sessions.usage.timeseries`, `usage.cost` → coûts/usage par
  session pour le webchat (KPI per-chat possible).
- `sessions.compact` (compaction manuelle), `sessions.steer`, `sessions.abort`.
- `voicewake.get/set` + `voicewake.routing.get/set`.
- `tools.effective` (inventaire d'outils par session) → notre toggle « Outils »
  peut devenir une vraie liste.
- Cron RPC complets (`cron.*`) — déjà hors périmètre webchat (Control UI le fait).

## 6. Mapping design (entrée de CONF-3)

**Par chat (composer, fréquent → visible)** : modèle (via `models.list`
filtré agents routés), réflexion. **Par chat (avancé, 1 niveau)** : fastMode
(« Vitesse »), reasoningLevel, verbose (read-only expliqué), compaction
manuelle, usage/coût de la session.
**Par agent (Settings, admin)** : workspace files (list/get/set + gauges
bootstrap), défauts thinking/fast par agent (`agents.update`).
**Global (Settings, admin)** : `agents.defaults.*` schéma-piloté
(`config.schema`), section Talk/voice (provider/transport/voix) préparée,
activée quand le mode Talk sera câblé.
**Provenance partout** : cascade inline→session→agent→global rendue visible
(badge/barre).

## 7. Non documenté / pièges
- Pas de surface « speed/serviceTier » distincte : c'est `fastMode` (mapping
  provider : OpenAI `priority`, Anthropic `auto`/`standard_only`).
- `agents.files.*` ne gère pas les sous-dossiers.
- `config.patch` : les remplacements destructifs exigent `replacePaths`.
- Le scope `agents.files.set` = admin → l'édition des workspace files dans le
  webchat doit passer par le bridge (qui a les scopes opérateur) + RBAC
  webchat côté Convex (permission dédiée, audit à la UI-9).
