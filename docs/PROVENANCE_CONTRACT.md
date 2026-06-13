# Contrat provenance/v1 — comment un plugin fait apparaître ses sources dans le chat

> Statut : NORMATIF — v1, 2026-06-12
> Public : auteurs de plugins OpenClaw qui injectent du contexte dans le LLM
> (mémoire conversationnelle, RAG documentaire, …) et veulent que l'utilisateur
> du webchat puisse voir « quelles sources ont nourri cette réponse ».
> Design et analyse : `docs/PROVENANCE_DESIGN.md`.
> Fixture de référence exécutable : `openclaw-webchat-bridge/local-openclaw/plugins/provenance-probe/`
> (utilisée par le banc local ET le CI — check C18 de la suite live-protocol).

---

## 1. Vue d'ensemble

```
plugin (before_prompt_build)
  └─ api.emitAgentEvent({ runId, sessionKey, stream:"<pluginId>.provenance", data:<rapport v1> })
        └─ bus d'événements agent → WS opérateur (pipe existant)
              └─ bridge: validation + bornes → addPart {kind:"provenance"}
                    └─ Convex: messagePart sous l'ACL du chat
                          └─ UI: ligne « Sources » par réponse (repliée, dépliable)
```

La détection est **pilotée par la donnée** : une instance sans plugin émetteur
ne produit aucune part → l'UI ne rend rien. Aucune capability à déclarer,
aucune configuration côté webchat.

## 2. Le transport — règles du gateway (vérifiées sur 2026.6.1 et 2026.6.5)

| Règle | Détail |
|---|---|
| API | `api.emitAgentEvent({ runId, sessionKey?, stream, data })` (SDK plugin) |
| **`runId` obligatoire** | Le gateway refuse l'événement sans runId. Le hook `before_prompt_build` le reçoit dans son contexte (`ctx.runId`). |
| **Stream scopé** | `stream` DOIT être `"<pluginId>"` ou `"<pluginId>.<suffixe>"`. Le contrat webchat impose le suffixe **`.provenance`** : `"openclaw-knowledge.provenance"`, `"hindsight-openclaw.provenance"`. Les streams hôte (`lifecycle`, `tool`, `item`, …) sont réservés. |
| **Identité authentifiée** | Le gateway estampille `pluginId` (et `pluginName`) DANS `data` — un plugin ne peut pas se faire passer pour un autre. Le webchat fait confiance à ce champ, jamais à une auto-déclaration. |
| Refus silencieux | En violation, l'appel retourne `{ emitted:false, reason }` **sans throw**. Loggez ce cas (`api.logger.info`) — sinon le silence est indiagnosticable. |
| Détection de version | `typeof api.emitAgentEvent === "function"` — absent sur les vieux SDK : n'émettez pas, n'échouez pas (l'injection reste fonctionnelle, le webchat ne montre simplement rien). |
| Timing | Émettre depuis `before_prompt_build` est CORRECT : la frame peut précéder l'ack `chat.send` côté bridge ; le bridge stash les rapports pré-tour par `runId` et les rattache au bon message. |

⚠ **Piège banc/CI** (vécu) : ne JAMAIS écrire `plugins.allow` sur un gateway
qui n'en a pas — une allowlist désactive TOUS les plugins stock non listés,
providers de modèles inclus (« Unknown model »). L'activation passe par
`plugins.entries.<id>.enabled` seul. Le manifeste du plugin doit déclarer
`"activation": { "onStartup": true }` (sans quoi il est listé mais jamais chargé).

⚠ **Quirk de re-registration** (vécu, 2026.6.1) : l'agent runtime RE-REGISTRE
les plugins à chaque run ; `emitAgentEvent` appelé via l'`api` d'une
re-registration est rejeté `{emitted:false, reason:"plugin is not loaded"}` —
seule l'api de la PREMIÈRE registration reste « loaded ». **Capturez-la dans
un singleton de module** et émettez toujours via elle (le cache ESM est
par-process) :

```js
let stableApi = null;
export default {
  register(api) {
    if (stableApi === null) stableApi = api;
    api.on("before_prompt_build", (event, ctx) => {
      const gw = stableApi ?? api;   // émettre via la PREMIÈRE api
      gw.emitAgentEvent({ /* … */ });
    });
  },
};
```
Sans ce pattern, l'émission marche au premier tour après redémarrage puis
échoue à tous les suivants. Le fixture `provenance-probe` l'implémente.

## 3. Le schéma `data` — rapport provenance/v1

```jsonc
{
  "v": 1,                                   // OBLIGATOIRE. Le bridge ignore tout autre v (fwd-compat).
  "source": "hindsight",                    // OBLIGATOIRE. Famille émettrice ("hindsight" | "knowledge" | …).
  "kind": "memory",                         // OBLIGATOIRE. "memory" | "documents" — le groupe UI.
  "injected": {                             // optionnel — métadonnées d'injection
    "chars": 420,
    "position": "system_prepend",           // system_prepend | system_append | user…
    "truncated": false
  },
  "retrieval": {                            // optionnel — métadonnées de la passe
    "route": "ALL",                         // décision de routeur
    "bank": "prod-agent::telegram::user",   // mémoire : bank id
    "collections": ["knowledge_olivier"],   // documents : collections pgvector
    "lightrag": { "mode": "mix" }           // documents : mode LightRAG (relevé en lightragMode)
  },
  "items": [                                // OBLIGATOIRE, non vide — les éléments injectés
    // item MÉMOIRE :
    { "id": "mem_…", "type": "observation", "date": "2026-06-01",
      "score": 0.91, "text": "…extrait injecté…" },
    // item DOCUMENT :
    { "file_name": "rapport.pdf", "collection": "knowledge_olivier",
      "score": 0.93, "text": "…chunk injecté…" }
  ]
}
```

### Bornes appliquées par le bridge (rejet ou troncature — jamais d'erreur de tour)

| Borne | Valeur | Effet |
|---|---|---|
| `items` | max **24** | tronqué |
| `text` par item | max **2 000** caractères | tronqué |
| autres chaînes | max 300 caractères | tronqué |
| rapport sérialisé | max **32 000** caractères | rapport ENTIER rejeté |
| rapports par tour (tous plugins) | max **8** | excédent ignoré |
| item sans aucun champ identifiant | — | item ignoré |
| `items` vide après filtrage | — | rapport ignoré (rien de citable) |
| champs inconnus | — | SUPPRIMÉS (reconstruction champ à champ, jamais de spread réseau) |

### Recommandation vie privée — niveaux d'émission

Implémentez une config `provenanceReport: "off" | "metadata" | "full"`
(défaut `"off"`) :
- `metadata` : items SANS `text` (titres, ids, types, dates, scores) —
  répond à « quels documents sont liés à cette réponse » ;
- `full` : avec les extraits exacts injectés — répond à « d'où vient cette
  information erronée ».

**Jamais de contenu dans les logs** (l'invariant tracing reste : métadonnées
seulement). Le rapport voyage uniquement sur le bus agent → il atterrit dans
la base du webchat **sous l'ACL du chat** (lecture owner-only).

**Logging des échecs d'émission — codes stables uniquement** (codex pass #36
P2, normatif depuis 2026-06-12) : en cas de `{emitted:false, reason}` ou de
throw, loggez une **catégorie stable** (`plugin_not_loaded`, `invalid_stream`,
`validation_error`, `rate_limited`, `rejected`, `throw:<Error.name>`) — JAMAIS
la `reason` brute ni `Error.message` : en mode `full`, un message d'erreur
peut renvoyer en écho des fragments du payload rejeté (extraits injectés)
droit dans le flux de logs. Implémentation de référence :
`openclaw-knowledge/src/provenance.ts` (`classifyRejectionReason`).

## 4. Ce que le webchat en fait

- Le bridge valide/borne (`src/core/provenance.ts`) et attache une
  `messagePart {kind:"provenance"}` au message assistant du run (`runId` est la
  clé de corrélation ; les frames pré-ack sont stachées par runId).
- **Discipline de payload** : le flux réactif (`listByChat`) ne transporte que
  la projection COMPACTE (textes d'items supprimés, flag `hasExcerpts`) — la
  fenêtre de conversation entière ne porte jamais les extraits. Les rapports
  complets sont servis par `messages.getProvenanceParts` (borné à UN message,
  owner-gated), chargés à la demande au dépliage du panneau.
- L'UI affiche sous la réponse une ligne compacte « Sources · 2 souvenirs ·
  1 document », dépliable en groupes **Mémoire conversationnelle** /
  **Documents** : titre (file_name/id/type), chips (type, date, collection,
  score) instantanés depuis la projection compacte ; les extraits arrivent en
  enrichissement progressif quand le détail est chargé.
- Message UTILISATEUR : jamais de panneau (les parts ne sont posées que sur
  les messages assistant).

## 5. Implémentation de référence (extrait du fixture)

```js
api.on("before_prompt_build", (event, ctx) => {
  if (typeof api.emitAgentEvent !== "function") return;   // vieux SDK: silence
  if (!ctx?.runId) return;                                // runId obligatoire
  const res = api.emitAgentEvent({
    runId: ctx.runId,
    ...(ctx.sessionKey ? { sessionKey: ctx.sessionKey } : {}),
    stream: "<pluginId>.provenance",
    data: {
      v: 1, source: "<famille>", kind: "memory" | "documents",
      injected: { chars, position },
      retrieval: { /* bank | collections | lightrag */ },
      items: [ /* ce que VOUS avez injecté, niveau selon provenanceReport */ ],
    },
  });
  if (res && res.emitted === false) api.logger.info(`provenance rejected: ${res.reason}`);
});
```

Règle d'or : **émettre EXACTEMENT ce qui a été injecté** (après seuils,
re-ranking et troncature), pas ce qui a été retrouvé — le rapport est la
vérité gelée de l'injection, c'est ce qui rend « d'où vient cette information
erronée » répondable.

## 6. Tester (banc local et CI)

```bash
# Banc : gateway épinglé + probe + bridge + stub + 18 checks (C18 = ce contrat)
cd openclaw-webchat-bridge/local-openclaw
./test-live-protocol.sh 2026.6.5

# Le fixture seul (sur un banc déjà up) :
./install-provenance-probe.sh
# puis envoyer un tour et vérifier les logs gateway :
docker logs oc-local-gateway --since 2m | grep provenance-probe
```

Le check **C18** pinne : 2 rapports déterministes → 2 parts `kind:"provenance"`
dans l'ingest (groupes memory+documents, `pluginId` estampillé, items exacts).
Sur un SDK sans `emitAgentEvent`, C18 attend le marqueur
`sdk-lacks-emitAgentEvent` et VÉRIFIE l'absence de parts (dégradé propre).

## 7. Versionnement du contrat

- `v` est un entier. Le bridge n'accepte que `v === 1` ; toute autre valeur est
  ignorée silencieusement (un plugin plus récent ne casse jamais un bridge plus
  ancien — skew avant), et un bridge plus récent continuera d'accepter v1
  (skew arrière). Un futur v2 sera ADDITIF et documenté ici.
- Toute évolution des bornes ou des champs passe par ce document + les tests
  des trois étages (bridge `test/provenance.test.ts`, Convex schéma, front
  `sourcesView.test.ts`) + le check C18.
