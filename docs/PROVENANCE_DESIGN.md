# Provenance du contexte injecté — « D'où vient cette réponse ? »

> Statut : DESIGN — 2026-06-12
> Initiative : rendre visible, par réponse et à la demande, ce qui a été
> transmis au LLM par la mémoire conversationnelle (Hindsight) et par la
> connaissance documentaire (LightRAG / pgvector), pour répondre à :
> « quels documents sont liés à cette réponse ? » et « d'où lui vient cette
> information erronée ? ».

---

## 1. Analyse — comment l'information atteint le LLM aujourd'hui

### 1.1 Les deux injecteurs (plugins gateway, repos locaux modifiables)

| | `@lacneu/hindsight-openclaw` (v0.8.0) | `@lacneu/openclaw-knowledge` (v3.2.4) |
|---|---|---|
| Rôle | Mémoire conversationnelle (banks par agent/canal/user) | RAG documentaire (pgvector + LightRAG, routeur de requête, reranker Jina) |
| Hook | `before_prompt_build` | `before_prompt_build` |
| Injection | `<hindsight_memories>` via `prependSystemContext` / `appendSystemContext` / `prependContext` (position configurable) | bloc documents via `appendSystemContext` |
| Ce que le plugin SAIT au moment d'injecter | `MemoryResult[]` (text, type world/experience/observation, mentioned_at, scores cross-encoder, bank id) | hits pgvector (file_name, collection, score), réponse LightRAG (mode, contextChars), décision routeur, reranking |
| Corrélation disponible | `ctx.sessionKey`, `ctx.runId`, `ctx.agentId` (PluginHookAgentContext) | idem |

### 1.2 Pourquoi le webchat ne voit RIEN aujourd'hui

L'injection se produit à l'**assemblage du prompt**, côté gateway, après l'envoi
du message par le bridge. Le bloc injecté :
- n'apparaît **pas** dans le transcript de session (`sessions.get`) — c'est de
  l'assemblage éphémère, pas un message persisté ;
- n'apparaît **pas** dans les frames opérateur existantes ;
- ne DOIT PAS passer par les logs : le module `tracing/events.ts` du plugin
  knowledge a un invariant vie-privée strict (métadonnées seulement — scores,
  comptes, durées ; jamais de contenu ni de hash de contenu) parce que les logs
  partent vers stdout/Opik. Cet invariant est correct et reste intact.

### 1.3 La découverte qui débloque tout (sondée sur le bundle 2026.6.5)

Le SDK plugin expose **`api.emitAgentEvent({ runId, stream, data, sessionKey })`**
— le bus d'événements agent du gateway, avec `stream` libre, séquencé par run,
et fanné vers les listeners **dont la souscription WS opérateur que le bridge
consomme déjà** (c'est par ce bus qu'arrivent `lifecycle`, `item`, `tool`,
`plan`, `approval`…). Un stream custom — scopé `<pluginId>.provenance`, le
gateway rejette les streams non scopés (découvert au probe P0) — voyage donc
du plugin jusqu'au normalizer du bridge **sans aucun nouveau service ni canal**.

(Également disponible : `api.registerGatewayMethod` — méthode RPC custom
interrogeable par le bridge. Retenu comme transport de REPLI si le probe P0
révélait un filtrage des streams inconnus sur le WS opérateur.)

---

## 2. Options considérées

| Option | Fidélité | Couplage | Verdict |
|---|---|---|---|
| **A. Émission à la source** : les plugins émettent un rapport structuré au moment exact de l'injection, via `emitAgentEvent` | Parfaite (gelé à l'injection — vérité serveur, même modèle que le forensic-feedback UI-9) | Zéro nouveau service ; réutilise frames→normalizer→ingest→parts | **RETENUE** |
| B. Lecture du transcript / diff du prompt | L'injection système n'est pas dans le transcript ; déplacer l'injection en position `user` la rendrait visible mais polluerait le message utilisateur (retain Hindsight, prompt caching) | Fragile | Rejetée |
| C. Re-query post-hoc des services (Hindsight `/v1/banks/*/memories/search`, LightRAG `/query`) | **Non fidèle** : retrieval non-déterministe, données qui évoluent — inacceptable pour « d'où vient l'info erronée » | Bridge→services (env) | Rejetée comme source de vérité ; **retenue en P5 optionnel** comme « Explorer », honnêtement étiquetée reconstruction |

---

## 3. Architecture retenue

> ⚠ Ce document est l'historique de DESIGN. La référence NORMATIVE (shapes
> exactes, règles gateway, bornes) est **`docs/PROVENANCE_CONTRACT.md`** — en
> cas de divergence, le contrat prévaut. Deux règles découvertes au banc après
> l'écriture de ce design sont intégrées ci-dessous : les streams plugins sont
> SCOPÉS (`<pluginId>.provenance`, un stream nu est rejeté par le gateway), et
> le `kind` du rapport est REMAPPÉ en `group` côté bridge (le discriminateur
> Convex `kind:"provenance"` doit rester intact).

```
┌─ gateway ──────────────────────────────────────────────┐
│ before_prompt_build:                                    │
│   hindsight-plugin ──┐                                  │
│                      ├─ injecte (system ctx, inchangé)  │
│   knowledge-plugin ──┘                                  │
│        │ et émet (opt-in):                              │
│        └ api.emitAgentEvent({runId, sessionKey,         │
│             stream:"<pluginId>.provenance",             │
│             data:<rapport v1>})                         │
│   (scoping imposé par le gateway ; pluginId estampillé  │
│    dans data = identité d'émetteur authentifiée)        │
└───────────────│────────────────────────────────────────┘
                ▼  (bus agent → WS opérateur, pipe existant)
┌─ bridge ───────────────────────────────────────────────┐
│ normalizer: stream se terminant par ".provenance"       │
│   → parseProvenanceReport (validation + bornes,         │
│     rapport.kind "memory"|"documents" → champ `group`)  │
│   → buffer pré-ack par runId → writer.addPart(part      │
│     {kind:"provenance", group, source, items…})         │
└───────────────│────────────────────────────────────────┘
                ▼  (ingest existant)
┌─ convex ───────────────────────────────────────────────┐
│ messageParts kind:"provenance" (additif) — ACL du chat  │
└───────────────│────────────────────────────────────────┘
                ▼  (listByChat réactif)
┌─ front ────────────────────────────────────────────────┐
│ Panneau « Sources » par message (pattern ToolActivity)  │
│ DATA-DRIVEN: pas de part → pas d'UI (instances sans     │
│ plugins = strictement rien, aucune capability à gérer)  │
└─────────────────────────────────────────────────────────┘
```

### 3.1 Schéma du rapport `provenance/v1` (commun aux deux plugins)

```jsonc
{
  "v": 1,
  "source": "hindsight" | "knowledge",   // plugin émetteur
  "kind": "memory" | "documents",        // groupe UI — REMAPPÉ en `group` par
                                         // le bridge (la part Convex garde son
                                         // discriminateur kind:"provenance")
  "ts": 1781300000000,
  "injected": { "chars": 3500, "position": "system_append", "truncated": false },
  "retrieval": {                          // métadonnées de la passe
    "route": "ALL" | "WORLD_ONLY" | "pgvector" | "lightrag" | …,
    "bank": "prod-agent::telegram::olivier",     // hindsight
    "collections": ["knowledge_olivier"],        // pgvector
    "lightrag": { "mode": "mix", "contextChars": 3800 }
  },
  "items": [
    // hindsight (kind memory):
    { "id": "mem_…", "type": "observation", "date": "2026-05-02",
      "score": 0.83, "text": "…" },              // text selon le niveau (cf. 3.2)
    // pgvector (kind documents):
    { "file_name": "ISO 27001_2013 Compliance Report.pdf",
      "collection": "knowledge_olivier", "score": 0.91, "text": "…" }
  ]
}
```

### 3.2 Vie privée & contrôle opérateur (opt-in, 3 niveaux)

Nouvelle config par plugin — `provenanceReport`:
- `"off"` (défaut → comportement actuel, zéro émission) ;
- `"metadata"` : items SANS texte (titres de fichiers, ids, types, dates,
  scores) — répond à « quels documents sont liés » ;
- `"full"` : + extraits injectés — répond à « d'où vient l'info erronée ».

Les rapports vont dans la **DB Convex sous l'ACL du chat** (owner-only via
listByChat), jamais dans les logs — l'invariant tracing reste intact. Le
contenu est du même niveau de sensibilité que les réponses du chat elles-mêmes
(qui dérivent déjà de ces sources).

### 3.3 Dégradés / absence de plugins (exigence multi-instances)

- **Instance sans plugins** : aucune frame → aucune part → l'UI ne rend rien.
  Détection « data-driven » — aucune capability gateway à déclarer, aucun
  manifeste à étendre, aucun risque de drift. (La leçon VCOMPAT : ici la
  donnée elle-même EST le signal de présence.)
- **Vieux plugin / plugin sans l'option** : idem, silence = rien.
- **`emitAgentEvent` absent du SDK** (gateway ancien) : le plugin teste
  `typeof api.emitAgentEvent === "function"` et n'émet pas — fail-silent,
  l'injection reste fonctionnelle.
- **Bridge ancien + plugins nouveaux** : la frame `<pluginId>.provenance` tombe
  dans le tally par défaut du normalizer (déjà tolérant aux streams inconnus)
  — ignorée proprement.

### 3.4 UI (pattern éprouvé ToolActivity / GC-P5)

- Ligne résumé compacte par message assistant, seulement si parts présentes :
  `Sources · 4 souvenirs · 3 documents` (i18n, pluriels).
- Panneau dépliable : groupes **Mémoire** (type/date/score/bank) et
  **Documents** (fichier/collection/score, mode LightRAG), extraits si niveau
  `full` (disclosure par item, fidèle au texte injecté).
- Préférence UI togglable via le registre uiPrefs existant (défaut admin +
  override user + gating système — pattern UI-prefs module).
- Toute projection pure extraite et table-testée (leçon GC-P5) ; aucun littéral
  accentué en src (ratchet).

---

## 4. Plan d'implémentation

| Phase | Périmètre | Livrable / gate |
|---|---|---|
| **P0 — Probe banc** | Mini-plugin jetable sur le banc (local-openclaw) qui émet `emitAgentEvent` stream `provenance` pendant `before_prompt_build` ; bridge en `BRIDGE_FRAME_DUMP` | Frame visible côté bridge avec runId/sessionKey corrects + timing pré-ack documenté. GO/NO-GO du transport (repli: `registerGatewayMethod` + pull post-run) |
| **P1 — Plugins** | Schéma `provenance/v1` partagé ; émission opt-in dans `hindsight-openclaw-plugin` et `openclaw-knowledge-plugin` ; tests unitaires ; release npm `@lacneu/*` | Tests verts dans les 2 repos ; CHANGELOG ; pas de changement de comportement par défaut |
| **P2 — Bridge** | Normalizer : capter le suffixe `.provenance`, buffer pré-`startAssistant` par runId, `addPart` (kind:"provenance", rapport.kind→`group`) ; check **C18** dans la suite live-protocol (le mini-plugin P0 devient l'outillage du banc) | 17→18 checks live-protocol ; tests unitaires frames |
| **P3 — Convex** | `messageParts` union + part `provenance` (additif, pas de backfill) ; validation défensive du rapport réseau | convex tests ; deploy additif |
| **P4 — Front** | Panneau Sources + i18n FR/EN + uiPrefs + tests des projections pures | npm test complet ; vérif chrome-devtools live |
| **P5 — Option « Explorer »** | Endpoints bridge → Hindsight/LightRAG (re-query honnêtement étiquetée « reconstruction actuelle », pas « ce qui a été injecté ») ; capability bridge dédiée | Différé — à décider après P4 |

### Synergie avec les initiatives existantes
- `design-lightrag-discovery-verbatim-split.md` (openclaw-notes) : le mode
  verbatim renforcera la valeur du niveau `full` (extraits exacts).
- Docstore sidecar (`ARCHITECTURE-KNOWLEDGE-DOCSTORE-RECONCILE.md`) : à terme,
  lien « ouvrir le document » depuis un item Documents.
- Opik/Langfuse : les events `[knowledge.event]` actuels restent la télémétrie
  opérateur ; la provenance utilisateur est un canal distinct, ACL chat.

---

## 5. Risques & parades

| Risque | Parade |
|---|---|
| Le WS opérateur filtre les streams inconnus (probe P0 négatif) | Repli `registerGatewayMethod("provenance.get", {runId})` + pull par le bridge après le run (pattern sessions.get du sink webchat) |
| Frame provenance AVANT l'ack `chat.send` (hook = pré-run) | Le normalizer admet déjà les frames pré-ack sur sessionKey ; buffer dédié jusqu'à `startAssistant` (même mécanique que les deltas précoces) |
| Fuite de contenu sensible dans des canaux non prévus | Niveaux off/metadata/full par instance ; jamais via logs ; parts sous ACL chat ; pas d'exposition API non authentifiée |
| Deux plugins → deux frames | Deux parts, deux groupes UI — voulu (séparation Mémoire/Documents demandée) |
| Versions de schéma | Champ `v` ; le bridge ignore les versions inconnues (fail-silent, comme compat) |
