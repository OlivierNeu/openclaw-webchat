# Architecture OpenClaw WebChat Bridge

Statut: document de référence pour l'implémentation initiale.
Date de rédaction: 2026-05-29.
Lecteurs cibles: Codex, Claude, Gemini, développeurs humains.

Ce document définit l'architecture cible d'un webchat dédié à OpenClaw. Il
remplace la logique d'intégration fragile via Open WebUI pour les usages
OpenClaw avancés, tout en conservant les leçons apprises dans le pipe OWUI:
captures NDJSON, isolation des `runId`, gestion des réponses différées,
sanitisation des chemins locaux et tests par traces réelles.

## 1. Résumé Exécutif

OpenClaw est nativement piloté par un Gateway WebSocket. Un tour utilisateur
peut produire plusieurs runs, des réponses intermédiaires, des frames tardives,
des événements de compaction, des messages issus d'outils, des messages
inter-sessions et des résultats envoyés après la fin de la requête HTTP qui a
déclenché le travail.

Open WebUI, via un pipe, reste fondamentalement un modèle requête/réponse:
le pipe écoute OpenClaw pendant un temps limité, retourne une réponse à OWUI,
puis n'écoute plus. Cette différence de modèle explique les bugs observés:
réponses perdues, messages tronqués, fichiers non cliquables, mauvais rattachement
de sources, confusion entre sessions OpenClaw, impossibilité de garantir la
récupération d'une réponse si l'utilisateur ferme le navigateur ou si OpenClaw
continue à travailler après le retour du pipe.

La solution cible est un webchat spécialisé, composé de:

- un frontend stable basé sur AI SDK UI;
- un backend bridge FastAPI;
- un endpoint de streaming HTTP compatible AI SDK UI, fourni par Pydantic AI
  via `VercelAIAdapter.dispatch_request()`;
- un agent/facade Pydantic AI qui encapsule OpenClaw au lieu d'appeler un LLM
  directement;
- des adaptateurs OpenClaw versionnés, capables de traduire les frames Gateway
  de chaque version OpenClaw vers un contrat applicatif stable;
- un journal technique de frames et d'événements pour reprise, audit, tests et
  diagnostic;
- une intégration Firebase Google Auth côté frontend et vérification serveur des
  ID tokens côté backend;
- deux modes de déploiement supportés dès le départ:
  1. frontend statique sur Firebase Hosting et backend Docker sur Synology;
  2. image Docker tout-en-un Synology embarquant frontend et backend;
- une stratégie multi-instance et multi-version afin de permettre les bumps
  OpenClaw instance par instance.

Décision structurante: le frontend ne doit jamais consommer directement les
frames brutes OpenClaw. Il doit consommer uniquement un flux stable AI SDK UI,
ou des événements applicatifs explicitement normalisés.

Décision structurante: le backend ne doit pas réimplémenter manuellement le
protocole de stream AI SDK UI. Il doit déléguer l'encodage du flux à Pydantic AI
`VercelAIAdapter`, et limiter notre code au mapping OpenClaw vers les événements
Pydantic AI.

## 2. Objectifs

### 2.1 Objectifs Fonctionnels

1. Offrir une interface chat stable pour les utilisateurs OpenClaw.
2. Exposer un backend bridge documenté pouvant être consommé par le frontend de
   référence ou par des frontends tiers.
3. Supporter plusieurs instances OpenClaw dans la même interface web.
4. Router chaque utilisateur authentifié vers l'instance, l'agent et l'adaptateur
   OpenClaw correspondant à sa configuration.
5. Permettre de bump une instance OpenClaw sans imposer le bump simultané des
   autres instances.
6. Préserver la stabilité frontend même si OpenClaw modifie son protocole Gateway.
7. Utiliser autant que possible les APIs et persistances natives OpenClaw:
   sessions, historique, runs, agent identity, médias, conversations de cron,
   conversations de sous-agents, previews.
8. Supporter les réponses longues, différées, multi-run et post-reconnexion.
9. Supporter les fichiers générés par OpenClaw avec liens cliquables et proxy
   sécurisé.
10. Préparer l'intégration des fonctionnalités vocales OpenClaw: speech-to-text,
   text-to-speech, voice call, barge-in et session temps réel.
11. Construire une base de tests de non-régression à partir des captures NDJSON
    et traces observées.
12. Servir de repository public professionnel: documentation claire,
    contribution guidée, politique de sécurité, contrat backend versionné et
    exemples de déploiement reproductibles.

### 2.2 Objectifs Non Fonctionnels

1. Robustesse lors des changements de versions OpenClaw.
2. Observabilité forte: traces, métriques, journal d'événements, corrélation
   `frontendChatId` / `sessionKey` / `runId` / `traceId`.
3. Sécurité: aucun token OpenClaw côté navigateur, aucun chemin local exposé,
   aucune fuite de payload sensible dans les logs applicatifs standards.
4. Reprise après fermeture d'onglet, reload, coupure réseau ou timeout Cloud Run.
5. Latence acceptable pour l'utilisateur, avec feedback visuel immédiat.
6. Livraison rapide via frontend statique Firebase Hosting et backend conteneurisé.
7. Architecture lisible par plusieurs agents de code sans interprétation implicite.

## 3. Non-Objectifs

1. Réécrire OpenClaw.
2. Répliquer toute la persistence conversationnelle d'OpenClaw.
3. Construire un clone complet d'Open WebUI.
4. Exposer le Gateway OpenClaw directement au navigateur.
5. Utiliser les frames OpenClaw brutes comme contrat frontend.
6. Implémenter à la main le protocole Vercel AI / AI SDK UI si Pydantic AI peut
   le fournir.
7. Corriger tous les cas OWUI existants dans cette nouvelle architecture. Le pipe
   OWUI reste un adaptateur de compatibilité, pas la cible long terme.

## 4. Sources et Documentation Consultées

Sources principales vérifiées le 2026-05-29:

- Pydantic AI UI integrations:
  https://pydantic.dev/docs/ai/integrations/ui/overview/
- Pydantic AI Vercel AI adapter API:
  https://pydantic.dev/docs/ai/api/ui/vercel_ai/
- AI SDK UI:
  https://ai-sdk.dev/docs/ai-sdk-ui
- AI SDK UI transport:
  https://v6.ai-sdk.dev/docs/ai-sdk-ui/transport
- AI SDK UI stream protocol:
  https://v5.ai-sdk.dev/docs/ai-sdk-ui/stream-protocol
- AI SDK UI resumable streams:
  https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-resume-streams
- Firebase Hosting rewrites:
  https://firebase.google.com/docs/hosting/full-config
- Firebase Hosting vers Cloud Run:
  https://firebase.google.com/docs/hosting/cloud-run
- Firebase Admin ID token verification:
  https://firebase.google.com/docs/auth/admin/verify-id-tokens
- Cloud Run WebSockets:
  https://docs.cloud.google.com/run/docs/triggering/websockets
- OpenClaw Gateway protocol:
  https://docs.openclaw.ai/gateway/protocol
- OpenClaw Gateway source documentation:
  https://github.com/openclaw/openclaw/blob/main/docs/gateway/protocol.md
- OpenClaw Control UI:
  https://openclawlab.com/en/docs/web/control-ui/
- OpenClaw Gateway API reference:
  https://clawdocs.org/reference/gateway-api
- PinchChat, webchat communautaire OpenClaw:
  https://github.com/MarlBurroW/pinchchat
- Libre WebUI OpenClaw integration:
  https://docs.librewebui.org/OPENCLAW_INTEGRATION/
- Libre WebUI plugin architecture:
  https://docs.librewebui.org/PLUGIN_ARCHITECTURE/
- Open WebUI OpenClaw quickstart:
  https://docs.openwebui.com/getting-started/quick-start/connect-an-agent/openclaw/

Synthèse des sources:

- Pydantic AI expose des adapters UI dont `VercelAIAdapter`, capables de recevoir
  une requête Starlette/FastAPI et de retourner une réponse streaming compatible
  protocole Vercel AI / AI SDK UI.
- `VercelAIAdapter.dispatch_request()` prend un `AbstractAgent`; OpenClaw doit
  donc être présenté comme un agent/facade compatible Pydantic AI.
- `sdk_version=6` est requis pour les workflows avancés de tool approval.
- AI SDK UI utilise un transport HTTP par défaut mais permet des transports et
  configurations personnalisées. Il supporte aussi la reprise de streams, sous
  réserve de persistence serveur et de compromis avec l'abort.
- Firebase Hosting peut servir le frontend et réécrire certaines routes vers
  Cloud Run. Les WebSockets côté backend relèvent de Cloud Run, avec timeout et
  nécessité de reconnexion.
- Le Gateway OpenClaw est le plan de contrôle WebSocket. Les clients officiels
  s'y connectent, déclarent leur rôle/scope et reçoivent des frames JSON. Les
  APIs Gateway incluent des opérations de sessions, previews, messages,
  subscriptions, runs et média selon version.

### 4.1 Référence Comparative Libre WebUI

Libre WebUI n'est pas l'architecture cible de ce projet, mais c'est une
référence comparative utile car elle documente une intégration OpenClaw maintenue
autour de deux idées importantes:

1. Un mode OpenAI-compatible/SSE pour les appels simples.
2. Un mode session persistante via Gateway WebSocket pour conserver outils,
   mémoire, workspace et continuité agentique.

Cette séparation confirme notre décision: OpenClaw ne doit pas être traité comme
un simple backend `/v1/chat/completions` lorsque l'objectif est une conversation
longue, multi-run, avec outils, fichiers, compaction, sous-agents et événements
tardifs. Notre bridge doit donc rester WebSocket-native côté OpenClaw, même si le
frontend consomme un contrat stable AI SDK UI.

#### Éléments à Réutiliser Comme Inspiration

- Le principe d'un service backend dédié aux sessions OpenClaw, responsable de la
  connexion Gateway, des reconnects, des subscriptions et de l'historique.
- La séparation entre configuration de provider, secrets, variables utilisateur
  et options runtime.
- Les règles de sécurité plugin/provider: ne pas exposer les secrets au client,
  valider les endpoints, éviter les fuites de credentials et réduire le risque
  SSRF.
- La documentation explicite des méthodes Gateway utiles: `chat.send`,
  `chat.abort`, `chat.history`, réponses `res`, événements `chat` et `agent`.
- L'idée de garder une compatibilité OpenAI/SSE pour certains clients sans en
  faire le contrat interne principal.

#### Éléments à Ne Pas Copier

- Ne pas baser le frontend directement sur les frames OpenClaw brutes.
- Ne pas limiter le design au mode OpenAI-compatible, car il ne couvre pas assez
  les comportements agentiques observés.
- Ne pas reprendre une clé de session simple si elle ne permet pas notre routing
  multi-instance, multi-utilisateur, multi-agent et versionné.
- Ne pas supposer qu'un seul format de frame OpenClaw sera stable entre les
  versions ou entre les instances olivier/jerome.
- Ne pas répliquer la persistence conversationnelle d'OpenClaw dans notre bridge.

#### Traduction en Exigences Pour Notre Bridge

Libre WebUI sert de check-list comparative pour les adapters OpenClaw:

- Chaque adapter doit couvrir les méthodes Gateway documentées par Libre WebUI et
  par les docs OpenClaw officielles.
- Chaque adapter doit tester les formes `chat` et `agent`, y compris les deltas,
  snapshots, finals, tool events et erreurs.
- Le backend doit avoir une couche de configuration secrets/provider similaire en
  esprit, mais adaptée à notre modèle `user -> instance -> agent -> adapter`.
- Les décisions de sécurité provider/plugin doivent être reflétées dans notre
  `SECURITY.md` futur: token OpenClaw côté serveur seulement, validation des URLs,
  sanitisation des médias, redaction des traces.
- Les tests de bump OpenClaw doivent inclure une comparaison avec les hypothèses
  Libre WebUI quand elles décrivent un comportement Gateway attendu.

#### Usage Pratique Pendant l'Implémentation

Quand un comportement OpenClaw n'est pas clair, un agent de code doit comparer:

1. Les traces NDJSON réelles du projet.
2. Les docs OpenClaw officielles.
3. Les docs Libre WebUI comme référence secondaire.
4. Les comportements du pipe OWUI existant.

Si ces sources divergent, les traces réelles et les docs OpenClaw officielles
priment. Libre WebUI sert alors à identifier des scénarios manquants ou des
tests supplémentaires, pas à imposer un contrat frontend.

## 5. Glossaire

`OpenClaw Gateway`
: Serveur WebSocket OpenClaw. Point d'entrée des clients, nodes, UI, bridges et
  outils.

`frame`
: Message JSON reçu depuis le Gateway. Peut être un `res`, `event`, `chat`,
  `agent`, `presence`, `health`, `lifecycle`, `tool`, etc.

`sessionKey`
: Identifiant OpenClaw d'une session/conversation. Il encode généralement
  l'agent, le canal, le type de conversation et un identifiant de conversation.

`runId`
: Identifiant d'un run OpenClaw. Un seul tour utilisateur peut produire plusieurs
  runs ou des runs de suivi.

`frontendChatId`
: Identifiant stable côté interface web. Il ne doit pas être confondu avec le
  `sessionKey` OpenClaw. Le backend mappe les deux.

`adapter OpenClaw`
: Module versionné qui connaît le contrat de frames d'une version OpenClaw donnée
  et produit des événements normalisés.

`OpenClawAsPydanticAgent`
: Facade qui présente OpenClaw comme un agent compatible Pydantic AI.

`AI SDK UI`
: Bibliothèque frontend Vercel pour gérer l'état conversationnel, les messages,
  le transport et le stream côté UI.

`VercelAIAdapter`
: Adapter Pydantic AI qui encode les événements agent en flux compatible AI SDK UI.

`event journal`
: Persistence technique locale des frames et événements normalisés. Elle sert à
  rejouer, diagnostiquer, reprendre un stream et produire des tests. Elle n'est
  pas la source fonctionnelle principale de l'historique conversationnel.

## 6. Architecture Cible

```text
┌──────────────────────────────────────────────────────────────────────┐
│ Browser                                                              │
│                                                                      │
│  React / AI SDK UI                                                   │
│  Firebase Google Auth                                                │
│  Stable normalized chat state                                        │
└───────────────┬──────────────────────────────────────────────────────┘
                │ HTTPS/WebSocket, stable webchat contract
                │ Authorization: Firebase ID token
                ▼
┌──────────────────────────────────────────────────────────────────────┐
│ Backend Bridge FastAPI                                               │
│                                                                      │
│  Phase 1 implemented:                                                │
│  /ws/chats/{chatId}                                                  │
│    └─ Browser WebSocket bridge + chat.history reconciliation         │
│                                                                      │
│  Synology all-in-one mode:                                           │
│    └─ optional static frontend served from OPENCLAW_WEBCHAT_STATIC_DIR│
│                                                                      │
│  Future AI SDK UI mode:                                              │
│  /api/chat                                                           │
│    └─ Pydantic AI VercelAIAdapter.dispatch_request()                 │
│                                                                      │
│  OpenClawAsPydanticAgent                                             │
│    ├─ Auth/Routing                                                   │
│    ├─ Conversation resolver                                          │
│    ├─ Adapter registry                                               │
│    ├─ Event journal                                                  │
│    ├─ Media proxy                                                    │
│    └─ Observability                                                  │
└───────────────┬──────────────────────────────────────────────────────┘
                │ Server-side WebSocket
                │ OpenClaw credentials never sent to browser
                ▼
┌──────────────────────────────────────────────────────────────────────┐
│ OpenClaw Gateway Instances                                           │
│                                                                      │
│  Instance olivier        Instance jerome         Future instances     │
│  Version A               Version B               Version N            │
│  Adapter A               Adapter B               Adapter N            │
└──────────────────────────────────────────────────────────────────────┘
```

### 6.1 Principe Central

Le frontend parle un seul langage: AI SDK UI. Le backend parle deux langages:

1. côté frontend: protocole AI SDK UI via Pydantic AI;
2. côté OpenClaw: Gateway WebSocket via adaptateurs versionnés.

Le backend est le seul endroit où les incompatibilités OpenClaw sont absorbées.

## 7. Layout de Repository Recommandé

Le repository doit être un monorepo applicatif, pas deux repositories séparés au
démarrage. La raison est pratique: les contrats partagés, fixtures de traces,
types de messages et tests de compatibilité doivent évoluer ensemble.

Layout cible:

```text
openclaw-webchat/
  README.md
  docs/
    ARCHITECTURE.md
    OPENCLAW_EVENT_CONTRACT.md
    SECURITY.md
    DEPLOYMENT.md
    TESTING_STRATEGY.md
    MIGRATION_FROM_OWUI.md

  apps/
    web/
      package.json
      src/
        app/
        auth/
        chat/
        media/
        voice/
        protocol/

    bridge/
      pyproject.toml
      app/
        main.py
        auth/
        config/
        routing/
        pydantic_agent/
        openclaw/
        media/
        journal/
        observability/
        security/
      tests/

  packages/
    protocol/
      normalized-events.schema.json
      generated-types/
    openclaw-fixtures/
      2026.5.19/
      2026.5.20/
      regression/

  infra/
    firebase/
    cloudrun/
    docker/
    terraform/
```

Le scaffold actuel `openclaw-webchat/backend` et `openclaw-webchat/frontend` peut
servir de preuve de concept. Avant l'implémentation long terme, il faut le
réorganiser vers `apps/bridge` et `apps/web`, ou documenter explicitement que
`backend` et `frontend` sont des noms temporaires.

## 8. Backend: Bridge OpenClaw vers AI SDK UI

### 8.1 Choix Technique

Le backend est un service Python FastAPI. Il expose au minimum:

- `POST /api/chat`: endpoint compatible AI SDK UI;
- `GET /api/chat/{chat_id}/stream`: endpoint de reprise si la stratégie resume
  AI SDK UI est activée;
- `GET /api/conversations`: liste des conversations accessibles;
- `GET /api/conversations/{id}`: détail + mapping vers session OpenClaw;
- `GET /api/media/{media_id}`: proxy média sécurisé;
- `GET /api/capabilities`: capacités activées pour l'utilisateur courant;
- endpoints admin/probe pour adapters et santé OpenClaw.

L'endpoint `POST /api/chat` ne doit pas construire manuellement les chunks
AI SDK UI. Il doit appeler Pydantic AI:

```python
from pydantic_ai.ui.vercel_ai import VercelAIAdapter

@app.post("/api/chat")
async def chat(request: Request) -> Response:
    deps = await build_deps_from_request(request)
    return await VercelAIAdapter.dispatch_request(
        request,
        agent=openclaw_agent,
        deps=deps,
        sdk_version=6,
        conversation_id=deps.frontend_chat_id,
        on_complete=deps.on_complete,
    )
```

Le code ci-dessus est intentionnellement conceptuel. Le spike devra vérifier
l'API exacte de Pydantic AI installée au moment de l'implémentation. Le principe
reste obligatoire: déléguer l'encodage AI SDK UI à Pydantic AI.

### 8.2 Facade `OpenClawAsPydanticAgent`

OpenClaw n'est pas un LLM provider classique. Il faut l'encapsuler comme un agent
Pydantic AI compatible avec `AbstractAgent`, probablement via une classe facade
ou un adapter qui implémente le contrat requis par Pydantic AI.

Responsabilités:

1. Recevoir l'entrée normalisée fournie par `VercelAIAdapter`.
2. Identifier l'utilisateur authentifié et ses droits.
3. Résoudre l'instance OpenClaw cible.
4. Résoudre l'agent OpenClaw cible.
5. Résoudre ou créer le `sessionKey`.
6. Envoyer le prompt à OpenClaw via `chat.send`, `sessions.send` ou API équivalente
   selon version.
7. Écouter les frames Gateway pertinentes.
8. Filtrer strictement par `sessionKey`, `runId`, provenance et contexte.
9. Mapper les frames OpenClaw vers événements Pydantic AI.
10. Journaliser frames et événements normalisés.
11. Interroger `chat.history` / `sessions.preview` / `sessions.describe` si une
    reconnexion ou un doute de synchronisation survient.
12. Terminer le stream seulement quand l'adaptateur de version a déterminé une
    fin de tour fiable.

Pseudo-interface:

```python
class OpenClawAsPydanticAgent:
    async def run_stream_events(
        self,
        user_prompt: str,
        message_history: Sequence[ModelMessage],
        deps: OpenClawRunDeps,
        **kwargs: Any,
    ) -> AsyncIterator[AgentStreamEvent]:
        context = await self.resolver.resolve(deps)
        adapter = self.adapter_registry.for_instance(context.instance)
        async with adapter.open_gateway(context) as gateway:
            send_result = await adapter.send_user_message(gateway, context, user_prompt)
            async for normalized in adapter.follow_turn(gateway, context, send_result):
                await self.journal.append(context, normalized)
                yield self.mapper.to_pydantic_event(normalized)
```

### 8.3 Pourquoi ne pas Considérer OpenClaw comme un Simple Model Provider

Un model provider classique reçoit une liste de messages et retourne des tokens.
OpenClaw orchestre un runtime agentique:

- plusieurs runs;
- outils;
- sous-agents;
- cron;
- compaction;
- sessions persistantes;
- média;
- voice;
- approvals;
- messages inter-canaux;
- état runtime indépendant de la requête HTTP.

Il faut donc wrapper OpenClaw au niveau agent, pas au niveau modèle texte.

## 9. Adaptateurs OpenClaw Versionnés

### 9.1 Motivation

Les bumps OpenClaw changent régulièrement la forme ou la sémantique des frames.
L'expérience OWUI a montré des différences entre instances olivier et jerome
malgré un pipe identique. Le système cible doit permettre:

- un adapter différent par instance;
- un adapter différent par version OpenClaw;
- des feature flags par instance;
- des probes runtime pour confirmer les capacités réelles;
- des tests de replay avant chaque bump.

### 9.2 Contrat d'Adapter

Chaque adapter doit implémenter un contrat stable:

```python
class OpenClawVersionAdapter(Protocol):
    version_range: VersionRange
    capabilities: OpenClawCapabilities

    async def connect(self, context: OpenClawContext) -> GatewayConnection:
        ...

    async def resolve_session(self, context: OpenClawContext) -> SessionBinding:
        ...

    async def send_user_message(
        self,
        gateway: GatewayConnection,
        context: OpenClawContext,
        prompt: UserPrompt,
    ) -> SendResult:
        ...

    async def follow_turn(
        self,
        gateway: GatewayConnection,
        context: OpenClawContext,
        send_result: SendResult,
    ) -> AsyncIterator[NormalizedOpenClawEvent]:
        ...

    async def fetch_history(
        self,
        gateway: GatewayConnection,
        session: SessionBinding,
        cursor: HistoryCursor | None,
    ) -> HistorySnapshot:
        ...
```

### 9.3 Règles d'Implémentation des Adapters

1. Aucun événement brut OpenClaw ne traverse la frontière vers `apps/web`.
2. Tout nouveau champ OpenClaw utilisé par le frontend doit d'abord être converti
   en événement normalisé.
3. Toute différence de version OpenClaw doit être confinée dans un adapter.
4. Aucun `if version == ...` dispersé dans le frontend ou le coeur du bridge.
5. Chaque adapter doit avoir des fixtures NDJSON de frames réelles.
6. Chaque bug production doit devenir une fixture de non-régression.
7. Un adapter doit définir explicitement les signaux de fin de tour.
8. Un adapter doit définir explicitement les frames ignorées et pourquoi.
9. Un adapter doit refuser les frames d'une autre `sessionKey` sauf si un mécanisme
   de rattachement inter-session est explicitement documenté.
10. Un adapter doit distinguer:
    - ACK privé;
    - progression visible;
    - réponse assistant livrable;
    - fichier généré;
    - source/document;
    - tool event;
    - lifecycle event;
    - compaction;
    - run de suivi;
    - événement étranger.

### 9.4 Registry

Le registry choisit l'adapter selon la configuration d'instance:

```json
{
  "instances": {
    "olivier": {
      "baseUrl": "wss://openclaw-olivier.example/gateway",
      "version": "2026.5.19",
      "adapter": "openclaw_2026_5_19",
      "capabilitiesProbe": true
    },
    "jerome": {
      "baseUrl": "wss://openclaw-jerome.example/gateway",
      "version": "2026.5.20",
      "adapter": "openclaw_2026_5_20",
      "capabilitiesProbe": true
    }
  }
}
```

Si `capabilitiesProbe=true`, le bridge doit vérifier au démarrage ou à intervalle
court:

- version Gateway;
- méthodes disponibles;
- formats de session;
- support `sessions.*`;
- support `agent.identity.get`;
- support media;
- support voice/talk;
- limites payload;
- politique d'authentification;
- comportement des events de fin.

## 10. Routing Utilisateur, Agent et Instance

### 10.1 Modèle Actuel

Actuellement chaque utilisateur est généralement lié à son propre agent OpenClaw.
Exemple conceptuel:

```text
olivier@lacneu.com -> instance olivier -> agent olivier
jerome@lacneu.com  -> instance jerome  -> agent jerome
```

### 10.2 Modèle Cible

Le système doit supporter plusieurs stratégies:

`dedicated_user_agent`
: un utilisateur authentifié est lié à un agent précis.

`shared_project_agent`
: plusieurs utilisateurs partagent un agent de projet.

`selectable_agent`
: l'utilisateur peut choisir un agent parmi ceux autorisés.

`system_agent`
: un agent technique est utilisé pour des workflows non rattachés à un humain.

`subagent_view`
: l'utilisateur consulte ou suit une session de sous-agent rattachée à son agent
  principal.

`cron_view`
: l'utilisateur consulte ou suit une conversation générée par une tâche cron de
  son agent.

Configuration conceptuelle:

```json
{
  "users": {
    "olivier@lacneu.com": {
      "defaultInstance": "olivier",
      "defaultAgentId": "olivier",
      "canonicalUserKey": "olivier",
      "routingMode": "dedicated_user_agent",
      "allowedInstances": ["olivier"],
      "allowedAgents": ["olivier"],
      "roles": ["admin", "agent-owner"]
    }
  },
  "projects": {
    "lightrag": {
      "routingMode": "shared_project_agent",
      "instance": "olivier",
      "agentId": "lightrag",
      "members": ["olivier@lacneu.com", "denis@lacneu.com"]
    }
  }
}
```

### 10.3 Règles de Sécurité de Routing

1. Le navigateur ne choisit jamais directement une instance OpenClaw arbitraire.
2. Le navigateur peut demander un contexte, mais le backend valide contre la
   matrice d'autorisation.
3. Le backend vérifie le Firebase ID token à chaque requête critique.
4. Le backend ne fait pas confiance aux messages d'historique fournis par le
   client; ils servent au protocole UI, pas à l'autorisation.
5. Les sessions de sous-agents et cron doivent être filtrées par ownership ou
   provenance OpenClaw vérifiable.

## 11. Identité Conversationnelle

### 11.1 Identifiants

Le système doit tracer séparément:

- `frontendChatId`: identifiant stable visible par le frontend.
- `openclawSessionKey`: session native OpenClaw.
- `openclawRunId`: run courant ou liste de runs liés.
- `openclawSeq`: séquence Gateway si disponible.
- `adapterVersion`: adapter utilisé.
- `instanceId`: instance OpenClaw.
- `agentId`: agent OpenClaw.
- `userEmail`: identité Firebase.
- `traceId`: corrélation observabilité.
- `streamId`: stream HTTP côté AI SDK UI si resume activé.

### 11.2 Mapping

Table conceptuelle:

```text
frontend_chat_bindings
  frontend_chat_id
  user_email
  instance_id
  agent_id
  openclaw_session_key
  openclaw_session_resolved_at
  adapter_id
  openclaw_version
  created_at
  updated_at
  archived_at
```

Cette table n'est pas la source du transcript. Elle est le mapping technique qui
permet de retrouver le transcript dans OpenClaw et de rattacher les streams.

### 11.3 Source de Vérité

OpenClaw reste la source de vérité fonctionnelle pour:

- messages persistés;
- sessions;
- runs;
- médias produits par OpenClaw;
- sous-agents;
- cron;
- historiques Gateway.

Le bridge peut persister:

- événements normalisés;
- copies de frames à des fins de diagnostic;
- cursors;
- état de stream actif;
- mapping chat/session;
- metadata d'observabilité;
- cache de previews.

Il ne doit pas devenir un deuxième système de vérité conversationnelle sauf
décision future explicitement documentée.

## 12. Streaming, Reprise et Fin de Tour

### 12.1 Problème Résolu

Le pipe OWUI échoue lorsque:

- OpenClaw envoie une première réponse puis continue à travailler;
- OpenClaw ferme ou repart un run;
- OpenClaw émet une réponse après que le pipe a retourné;
- le navigateur ferme pendant un run;
- un autre prompt est envoyé pendant que le précédent travaille;
- une compaction ou un run de suivi produit des frames tardives.

Le bridge doit maintenir un lien logique avec OpenClaw indépendamment du cycle
de vie exact de la requête HTTP frontend.

### 12.2 Mode Nominal

1. Le frontend envoie un message via AI SDK UI.
2. `VercelAIAdapter.dispatch_request()` reçoit la requête.
3. `OpenClawAsPydanticAgent` résout le contexte.
4. L'adapter OpenClaw envoie le message au Gateway.
5. L'adapter suit les frames pertinentes.
6. Les événements normalisés sont mappés vers événements Pydantic AI.
7. Pydantic AI encode le flux AI SDK UI.
8. Le frontend affiche tokens, étapes, outils, fichiers et statut.

### 12.3 Reprise Après Refresh ou Fermeture Navigateur

AI SDK UI supporte la reprise de streams, mais la documentation signale un
compromis avec l'abort: fermer ou rafraîchir une page peut déclencher un signal
d'abort qui interrompt le mécanisme de reprise si l'application l'utilise tel quel.

Règle cible:

- le frontend peut fermer le flux HTTP;
- le backend ne doit pas nécessairement annuler le run OpenClaw;
- l'état actif doit être journalisé;
- au retour du navigateur, le backend doit:
  1. vérifier le mapping `frontendChatId`;
  2. interroger OpenClaw history/preview/session;
  3. lire l'event journal local;
  4. reconstruire l'état visible;
  5. reprendre le flux si un run est encore actif, ou afficher le résultat final.

Cette logique doit être testée avec:

- reload pendant tool call;
- fermeture tab pendant image generation;
- fermeture tab après première réponse mais avant fichier final;
- reconnexion après timeout Cloud Run;
- deuxième message envoyé alors que le premier est encore actif.

### 12.4 Fin de Tour

La fin de tour ne doit pas être déduite d'un seul `chat:final` vide. L'expérience
OWUI a montré que ce signal peut être précoce ou ambigu.

Un adapter doit combiner:

- `runId` courant;
- `sessionKey`;
- `lifecycle:end`;
- `chat:final` avec contenu;
- absence de run actif confirmée par OpenClaw si API disponible;
- `agent.wait` ou équivalent si disponible;
- history reconciliation;
- timeout adaptatif;
- règles spécifiques à la version OpenClaw.

La fin de stream vers AI SDK UI doit être déclenchée seulement quand l'adapter
peut déclarer l'un de ces états:

`completed_visible`
: réponse visible et run terminé.

`completed_empty`
: run terminé sans contenu livrable, confirmé par OpenClaw.

`completed_file_only`
: run terminé avec fichier ou média livrable.

`waiting_background`
: la réponse principale est terminée mais des événements de fond peuvent arriver;
  le frontend doit pouvoir se resynchroniser via history.

`failed`
: erreur terminale OpenClaw ou adapter.

`aborted_by_user`
: annulation explicite utilisateur.

`disconnected_recoverable`
: perte de connexion, état récupérable via reprise/history.

## 13. Événements Normalisés

Le bridge doit définir un schéma stable. Exemple conceptuel:

```json
{
  "type": "assistant_message_delta",
  "frontendChatId": "c4796b44-dc2b-4d58-b961-7890fdfbd43e",
  "openclawSessionKey": "agent:olivier:webchat:chat:olivier:c479...",
  "runId": "run_...",
  "sequence": 42,
  "text": "Bonjour",
  "visibility": "visible",
  "createdAt": "2026-05-29T12:00:00Z"
}
```

Types minimaux:

- `turn_started`
- `assistant_message_delta`
- `assistant_message_final`
- `status_update`
- `tool_started`
- `tool_progress`
- `tool_completed`
- `tool_failed`
- `file_created`
- `file_available`
- `source_attached`
- `approval_required`
- `approval_resolved`
- `compaction_started`
- `compaction_completed`
- `run_followup_started`
- `run_completed`
- `turn_completed`
- `turn_failed`
- `history_reconciled`
- `voice_session_started`
- `voice_transcript_delta`
- `voice_audio_available`
- `security_sanitized`

Chaque événement normalisé doit contenir au minimum:

- `eventId`;
- `type`;
- `frontendChatId`;
- `instanceId`;
- `agentId`;
- `openclawSessionKey`;
- `runId` si disponible;
- `adapterId`;
- `createdAt`;
- `rawFrameRef` si une frame brute a été journalisée;
- `visibility`;
- `securityClassification`.

## 14. Fichiers, Médias et Liens Cliquables

### 14.1 Règle de Sécurité

Aucun chemin local OpenClaw ne doit être affiché au navigateur:

- pas de `/home/node/.openclaw/...`;
- pas de `/openclaw/open-webui/data/...`;
- pas de chemins NAS;
- pas de chemins temporaires;
- pas de `file://`.

Les réponses texte doivent être sanitizées avant sortie frontend. Si OpenClaw
fournit un chemin local, le bridge doit:

1. vérifier que le fichier est un média autorisé;
2. créer un `mediaId` opaque;
3. exposer un lien backend `/api/media/{mediaId}`;
4. afficher uniquement le nom de fichier nettoyé;
5. journaliser la sanitisation sans exposer le chemin.

### 14.2 Proxy Média

Le proxy média doit:

- vérifier l'authentification Firebase;
- vérifier que l'utilisateur a accès à la session liée;
- vérifier la provenance OpenClaw du média;
- définir `Content-Disposition`;
- définir `Content-Type`;
- supporter preview et download;
- limiter taille et types MIME;
- journaliser les accès;
- refuser les chemins non autorisés;
- ne jamais accepter un chemin brut fourni par le navigateur.

### 14.3 Mapping AI SDK UI

Les fichiers doivent être exposés au frontend via les abstractions du protocole
AI SDK UI/Pydantic AI lorsque possible:

- `FileChunk` si l'adapter Pydantic le supporte;
- data part typée si nécessaire;
- fallback: lien markdown sécurisé uniquement si le renderer frontend le gère.

Le bug "fichier visible mais non cliquable" doit devenir un test contractuel.

## 15. Sources, Documents et RAG

OpenClaw peut produire des sources/document chunks qui ne sont pas des fichiers
uploadés par l'utilisateur. Le frontend doit distinguer:

- fichier attaché par l'utilisateur;
- fichier généré par l'agent;
- source documentaire RAG;
- extrait utilisé en contexte;
- média OpenClaw;
- transcript de sous-agent;
- résultat d'outil.

Le badge "Sources" ne doit pas apparaître si les sources proviennent d'un état
stale, d'un prompt précédent ou d'un contexte OpenClaw non lié au tour actuel.

Règle:

- une source affichée doit être rattachée explicitement au `turnId` ou `runId`;
- sinon elle peut être visible dans un panneau diagnostic, pas dans le message
  principal.

## 16. Authentification et Autorisation

### 16.1 Firebase Auth

Le frontend utilise Firebase Google Sign-In.

Le backend vérifie les ID tokens avec Firebase Admin SDK. Le token doit être
envoyé dans `Authorization: Bearer <idToken>` ou via le mécanisme accepté par le
transport AI SDK UI configuré.

Le backend doit vérifier:

- signature token;
- expiration;
- audience/projet Firebase;
- email verified si requis;
- domaine autorisé;
- appartenance au mapping utilisateur/projet;
- rôle applicatif.

### 16.2 Secrets

Le navigateur ne reçoit jamais:

- token Gateway OpenClaw;
- secret OpenClaw;
- clé Opik/Langfuse;
- chemin local;
- configuration complète multi-instance.

Les secrets sont injectés côté backend via variables d'environnement, Secret
Manager ou équivalent.

### 16.3 Logs et PHI

Les captures de frames peuvent contenir prompts, réponses, médias et données
sensibles. Elles doivent être désactivables, TTLisées, protégées et exclues des
logs standards.

Deux niveaux:

`frame_capture_raw`
: diagnostic local ciblé, sensible, accès restreint.

`observability_safe`
: export Opik/Langfuse/metrics, redaction forte, pas de payload complet.

## 17. Observabilité

### 17.1 Corrélation

Chaque tour doit produire une corrélation:

```text
traceId
  frontendChatId
  openclawSessionKey
  runIds[]
  adapterId
  instanceId
  userEmail
  streamId
```

### 17.2 Opik et Langfuse

Objectif:

- exporter des diagnostics structurés utiles;
- ne pas exporter les payloads complets par défaut;
- attacher les résumés de frames, counts, états de fin, erreurs, timings;
- permettre une recherche par `sessionKey`, `runId`, `frontendChatId`.

Exemples de metadata utiles:

- nombre de frames brutes;
- nombre de frames filtrées;
- nombre de frames étrangères;
- transitions lifecycle;
- raisons de fin;
- temps avant premier token;
- temps avant premier contenu visible;
- temps total;
- nombre de runs;
- fichiers générés;
- médias disponibles;
- sanitisation appliquée;
- erreurs Gateway;
- reconnexion.

### 17.3 Capture NDJSON

Le captureur NDJSON reste indispensable pour les bumps. Il doit exister dans la
nouvelle architecture, mais être contrôlable à chaud:

- via configuration backend dynamique;
- via endpoint admin sécurisé;
- via TTL;
- par utilisateur/session/instance;
- avec rotation et taille maximale;
- avec mode raw et mode redacted.

## 18. Voice, TTS et STT

OpenClaw expose ou prévoit des capacités vocales via Gateway/talk:

- sessions temps réel;
- WebRTC ou provider-websocket;
- speech-to-text;
- text-to-speech;
- annulation de sortie audio;
- barge-in VAD;
- outils vocaux.

Architecture cible:

```text
Browser Voice UI
  ├─ Microphone capture
  ├─ Audio playback
  ├─ Voice controls
  └─ WebRTC/WebSocket as required

Backend Bridge
  ├─ Auth/session validation
  ├─ Voice capability negotiation
  ├─ Token/session creation via OpenClaw Gateway
  ├─ Optional relay if required
  └─ Transcript normalization

OpenClaw Gateway
  └─ talk.* APIs / realtime provider
```

Règles:

1. Ne pas implémenter voice dans le premier incrément chat texte.
2. Prévoir le modèle de capacités maintenant.
3. Ne jamais exposer les credentials provider au navigateur sans token éphémère
   généré par le backend.
4. Traiter les transcripts vocaux comme des messages normalisés.
5. Tester le barge-in séparément du chat texte.

## 19. Frontend

### 19.1 Stack

Stack recommandée:

- React;
- TypeScript;
- AI SDK UI;
- Firebase Auth;
- Vite ou Next.js selon choix final;
- UI maison ou assistant-ui plus tard si elle apporte une valeur concrète.

Firebase Hosting reste adapté pour une app React statique. Le backend reste sur
Cloud Run ou Docker.

### 19.2 Pourquoi AI SDK UI

AI SDK UI apporte:

- gestion d'état chat;
- streaming;
- transports configurables;
- support des messages structurés;
- reprise de stream;
- intégration naturelle avec Vercel AI protocol;
- base maintenue par un tiers.

Le frontend ne doit pas coder manuellement:

- parsing de frames OpenClaw;
- interprétation des `runId`;
- règles de fin de tour;
- sanitisation de chemins;
- mapping média OpenClaw;
- retry OpenClaw.

### 19.3 Contrat Frontend

Le frontend peut connaître:

- `frontendChatId`;
- message parts AI SDK UI;
- status normalisé;
- file parts sécurisés;
- source parts sécurisées;
- capabilities de l'utilisateur;
- erreurs utilisateur lisibles.

Le frontend ne doit pas connaître:

- Gateway token;
- raw frame;
- chemin local;
- adapter internals;
- secrets d'instance;
- version OpenClaw comme condition de rendering, sauf affichage diagnostic.

## 20. Déploiement

### 20.1 Décision de Déploiement Actuelle

Le déploiement initial doit privilégier Synology pour le backend. Les instances
OpenClaw vivent déjà dans cette infrastructure, les secrets et volumes médias
sont locaux, et les itérations Container Manager sont contrôlables sans dépendre
immédiatement d'un runtime Cloud.

Deux modes sont officiellement supportés:

1. **Firebase Hosting + backend Docker Synology**
   - le frontend React/Vite est servi par Firebase Hosting;
   - le backend FastAPI tourne dans Synology Container Manager;
   - `VITE_OPENCLAW_BRIDGE_WS_URL` pointe vers le domaine public WebSocket du
     backend Synology, par exemple `wss://openclaw-webchat-api.example.com`;
   - ce mode optimise la rapidité de livraison frontend.

2. **Image Docker tout-en-un Synology**
   - le `Dockerfile` racine build le frontend puis copie `dist/` dans l'image
     backend;
   - FastAPI sert le frontend quand `OPENCLAW_WEBCHAT_STATIC_DIR` pointe vers
     le dossier statique buildé;
   - `VITE_OPENCLAW_BRIDGE_WS_URL` reste vide pour que le navigateur utilise le
     même host: `wss://<host-actuel>/ws/chats/...`;
   - ce mode se rapproche du modèle Open WebUI: un seul container expose UI,
     API, WebSocket et proxy média.

Le mode Cloud Run reste une cible future, mais pas la cible de déploiement
initiale.

### 20.2 Option A: Firebase Frontend + Synology Backend

Frontend:

- Firebase Hosting;
- CDN statique;
- déploiement rapide;
- Google Auth naturel.

Backend:

- Docker sur Synology Container Manager;
- domaine HTTPS/WSS exposé via le reverse proxy existant;
- accès local aux instances OpenClaw;
- accès read-only au répertoire `media/outbound`;
- secrets gérés côté NAS/container.

Schéma:

```text
chat.lacneu.com
  └─ Firebase Hosting static frontend
       └─ wss://openclaw-webchat-api.lacneu.com/ws/chats/{chatId}
            └─ Synology Docker backend
                 └─ OpenClaw Gateway WebSocket
```

### 20.3 Option B: Synology Tout-en-Un

Frontend:

- React/Vite buildé dans l'image Docker;
- fichiers statiques servis par FastAPI;
- aucun besoin de Firebase Hosting pour servir l'UI.

Backend:

- FastAPI dans la même image;
- `/ws/chats/{chatId}` sur le même domaine que l'UI;
- `/api/media/outbound/{filename}` sur le même domaine que l'UI;
- `OPENCLAW_WEBCHAT_STATIC_DIR=/app/static`.

Schéma:

```text
chat.lacneu.com
  └─ Synology Docker all-in-one
       ├─ /                  frontend dist
       ├─ /ws/chats/{chatId} backend WebSocket
       ├─ /api/media/...     signed media proxy
       └─ OpenClaw Gateway WebSocket
```

### 20.4 Option C Future: Firebase Frontend + Cloud Run Backend

Cloud Run reste possible, mais il faut tenir compte du coût des connexions
WebSocket longues. Un domaine backend explicite comme `bridge.lacneu.com` ou
`ws.lacneu.com` reste préférable car Firebase Hosting ne doit pas être considéré
comme un proxy WebSocket générique.

### 20.5 Local

Local recommandé:

```text
docker compose up bridge redis
npm run dev --workspace apps/web
```

ou:

```text
uvicorn app.main:app --reload --port 8080
npm run dev
```

### 20.6 Persistence Technique

Pour le premier incrément robuste:

- Redis pour streams actifs, locks et cursors;
- Postgres ou SQLite durable pour mapping conversation/session et event journal;
- fichiers NDJSON optionnels pour captures de debug.

En production Cloud Run:

- Redis/Memorystore ou Firestore pour état actif;
- Postgres/Cloud SQL ou Firestore pour mapping durable;
- Cloud Storage pour captures volumineuses si nécessaire.

## 21. Tests et Gate de Bump OpenClaw

### 21.1 Principe

Chaque régression observée doit devenir une fixture. Chaque bump OpenClaw doit
passer par un replay de fixtures avant activation pour un utilisateur réel.

### 21.2 Types de Tests

`unit`
: fonctions pures: sanitisation, session key, routing, mapping d'événements.

`adapter_contract`
: replay de frames NDJSON OpenClaw vers événements normalisés attendus.

`ai_sdk_protocol`
: vérifie que Pydantic AI produit des flux consommables par AI SDK UI.

`history_reconciliation`
: simule fermeture navigateur et reprise via OpenClaw history.

`media_security`
: vérifie absence de path leak et URLs signées/proxy.

`multi_instance`
: même frontend, deux utilisateurs, deux instances, deux adapters.

`version_bump`
: compare fixtures version N et N+1.

`e2e_local`
: frontend + backend + fake OpenClaw Gateway.

`gateway_live_smoke`
: test manuel ou semi-automatique contre instance staging.

### 21.3 Fixtures Obligatoires Initiales

À partir des bugs déjà rencontrés:

1. `chat:final` vide avant contenu.
2. Réponse finale après `lifecycle:end`.
3. Run de suivi avec nouveau `runId`.
4. Compaction automatique.
5. ACK privé puis message visible.
6. Fichier généré cliquable.
7. Fichier généré avec path local dans texte.
8. Source stale issue d'un prompt précédent.
9. Deux fichiers apparents alors qu'un seul upload était prévu.
10. Browser close/reconnect pendant run long.
11. Prompt envoyé pendant run actif.
12. Réponse OpenClaw visible dans Control UI mais non reçue par OWUI.
13. Différence olivier/jerome de format de réponse.
14. Image generation qui envoie le résultat après fin apparente du tour.
15. Session OpenClaw recréée ou canonicalisée différemment.

### 21.4 Pipeline de Bump

Pour bump une instance OpenClaw:

1. Capturer la version actuelle:
   - health;
   - sessions.list;
   - capabilities probe;
   - fixtures critiques.
2. Déployer OpenClaw N+1 sur une seule instance.
3. Exécuter probes adapter.
4. Exécuter replay fixtures N.
5. Capturer nouvelles traces N+1.
6. Ajouter/mettre à jour adapter si nécessaire.
7. Exécuter tests contractuels.
8. Activer adapter pour un utilisateur canary.
9. Observer Opik/Langfuse/NDJSON.
10. Étendre aux autres utilisateurs/instances.

Règle: aucun bump global sans adapter validé sur fixtures.

## 22. Gestion des Prompts Concurrentiels

OpenClaw peut mettre en queue un prompt si le précédent n'est pas terminé. OWUI
peut avoir des comportements différents selon configuration. Le webchat cible
doit rendre cela explicite.

Le frontend doit afficher:

- message en cours;
- message en queue;
- run actif;
- possibilité d'annuler;
- possibilité de "steer" si OpenClaw supporte `sessions.steer`;
- état reconnectable si l'utilisateur ferme la page.

Le backend doit:

- ne pas lancer deux runs concurrents sur une session si OpenClaw attend une file;
- utiliser les APIs OpenClaw de queue/steer/abort si disponibles;
- persister l'état des prompts queued;
- réconcilier avec OpenClaw au retour.

## 23. Erreurs et Dégradations

Classes d'erreurs:

`user_recoverable`
: l'utilisateur peut réessayer.

`auth_required`
: token expiré, relogin.

`authorization_denied`
: utilisateur non autorisé pour l'agent/session.

`openclaw_unavailable`
: instance down.

`openclaw_protocol_changed`
: adapter ne reconnaît pas une frame critique.

`stream_disconnected`
: HTTP stream coupé mais run potentiellement actif.

`media_unavailable`
: fichier non trouvé ou non autorisé.

`security_sanitized`
: contenu modifié pour empêcher fuite.

Règle UX:

- l'utilisateur ne doit pas voir une réponse vide si OpenClaw travaille encore;
- l'utilisateur doit voir un statut clair si le bridge a perdu le stream;
- un bouton "resynchroniser" doit pouvoir relancer history reconciliation;
- les erreurs internes OpenClaw ne doivent pas exposer secrets ou chemins.

## 24. Compatibilité avec OWUI Pendant la Transition

Le pipe OWUI peut rester en production temporairement. Il doit être considéré
comme:

- outil de compatibilité;
- source de fixtures;
- référence de bugs à ne pas reproduire;
- non cible long terme pour les interactions OpenClaw complexes.

Pendant la migration:

1. garder le pipe stable;
2. garder le captureur NDJSON;
3. ajouter des fixtures issues du pipe;
4. comparer les réponses OWUI et WebChat sur prompts connus;
5. basculer progressivement les utilisateurs.

## 25. Plan d'Implémentation

### Phase 0: Stabiliser les Artefacts de Diagnostic

Livrables:

- conserver le captureur NDJSON;
- centraliser les fixtures existantes;
- documenter chaque bug historique;
- créer une nomenclature de fixtures.

Critère de sortie:

- au moins 10 fixtures de régression rejouables localement.

### Phase 1: Monorepo et Contrats

Livrables:

- structure `apps/web`, `apps/bridge`, `packages/protocol`;
- schéma JSON des événements normalisés;
- types TypeScript générés;
- modèles Python Pydantic correspondants;
- tests unitaires schema.

Critère de sortie:

- Python et TypeScript partagent le même contrat d'événements.

### Phase 2: Spike Pydantic AI Adapter

Livrables:

- endpoint FastAPI `/api/chat`;
- appel réel à `VercelAIAdapter.dispatch_request()`;
- agent Pydantic minimal fake;
- frontend AI SDK UI minimal qui consomme le stream;
- test e2e fake agent.

Critère de sortie:

- aucun chunk AI SDK UI écrit manuellement par notre code.

### Phase 3: Facade OpenClaw Fake Gateway

Livrables:

- fake OpenClaw Gateway en tests;
- adapter `openclaw_fake`;
- mapping frames fake vers événements Pydantic;
- tests de fin de tour, run follow-up, file event.

Critère de sortie:

- le frontend reçoit une réponse streamée depuis un Gateway simulé.

### Phase 4: Adapter OpenClaw 2026.5.19

Livrables:

- adapter `openclaw_2026_5_19`;
- handshake Gateway;
- send message;
- session resolve;
- history fetch;
- media proxy;
- replay des fixtures olivier/jerome connues.

Critère de sortie:

- prompts texte, fichiers et cas de compaction passent sur fixtures.

### Phase 5: Multi-Instance et Routing

Livrables:

- configuration instances;
- mapping users;
- adapter registry;
- tests olivier/jerome;
- capabilities probe.

Critère de sortie:

- deux utilisateurs peuvent utiliser deux instances/version/adapters différents
  depuis le même frontend.

### Phase 6: Reprise et Journal

Livrables:

- event journal;
- stream state;
- history reconciliation;
- endpoint resume;
- tests fermeture navigateur/reload.

Critère de sortie:

- une réponse OpenClaw terminée après fermeture navigateur est visible après
  reconnexion.

### Phase 7: Observabilité

Livrables:

- traces Opik/Langfuse redacted;
- metadata corrélée;
- export des diagnostics de stream;
- toggles capture.

Critère de sortie:

- depuis une trace, on peut retrouver chat, session, run, adapter et raison de fin.

### Phase 8: Voice

Livrables:

- capability model voice;
- UI controls;
- token/session voice via backend;
- transcript events;
- tests STT/TTS séparés.

Critère de sortie:

- voice peut être activé pour un utilisateur canary sans modifier le contrat texte.

### Phase 9: Migration Utilisateurs

Livrables:

- guide de migration depuis OWUI;
- canary;
- rollback;
- monitoring;
- nettoyage des bugs pipe non nécessaires.

Critère de sortie:

- les utilisateurs critiques utilisent WebChat pour OpenClaw.

## 26. Risques et Décisions à Valider par Spike

### 26.1 API Exacte de Pydantic AI `AbstractAgent`

La documentation confirme que `VercelAIAdapter.dispatch_request()` reçoit un
`AbstractAgent`, mais l'implémentation exacte à fournir doit être validée dans le
code avec la version installée. Il faudra vérifier:

- méthodes abstraites requises;
- format exact des `AgentStreamEvent`;
- génération de `FileChunk`;
- tool approval en `sdk_version=6`;
- hooks `on_complete`;
- gestion de `message_history`;
- `conversation_id`.

### 26.2 Reprise AI SDK UI

AI SDK UI supporte la reprise, mais documente une incompatibilité possible avec
l'abort. Il faut décider:

- désactiver l'abort automatique sur fermeture navigateur;
- ou accepter que fermer l'onglet annule explicitement le run;
- ou séparer "close stream HTTP" et "abort OpenClaw run".

Notre besoin métier impose plutôt: fermer l'onglet ne doit pas perdre la réponse
OpenClaw. Donc il faudra implémenter une reprise robuste côté backend.

### 26.3 APIs OpenClaw Disponibles par Version

À vérifier par probes:

- `sessions.list`;
- `sessions.describe`;
- `sessions.preview`;
- `sessions.resolve`;
- `sessions.messages.subscribe`;
- `sessions.send`;
- `sessions.steer`;
- `sessions.abort`;
- `agent.wait`;
- `agent.identity.get`;
- media/download APIs;
- talk/voice APIs.

### 26.4 Hébergement WebSocket

Le flux principal AI SDK UI est HTTP streaming. Le backend parle WebSocket avec
OpenClaw. Si le frontend a besoin d'un canal WebSocket direct pour certaines
features live/voice, il faudra valider:

- Firebase Hosting rewrites;
- Cloud Run custom domain;
- timeouts;
- reconnexion;
- scaling.

## 27. Règles pour Agents de Code

Ces règles sont obligatoires pour Codex, Claude et Gemini.

1. Ne jamais exposer les frames brutes OpenClaw au frontend.
2. Ne jamais réimplémenter manuellement le protocole AI SDK UI tant que
   `VercelAIAdapter` répond au besoin.
3. Tout changement lié à une version OpenClaw doit être isolé dans un adapter
   versionné.
4. Toute régression observée doit devenir une fixture.
5. Aucun chemin local ne doit apparaître dans une réponse utilisateur.
6. Aucun token OpenClaw ne doit être envoyé au navigateur.
7. Le backend ne doit pas faire confiance à l'historique envoyé par le client pour
   l'autorisation.
8. OpenClaw reste la source de vérité des conversations; le bridge journalise pour
   reprise et diagnostic.
9. Les tests doivent inclure les deux instances connues dès que les fixtures sont
   disponibles.
10. Les statuts utilisateur doivent être explicites: en cours, en queue, terminé,
    reprise possible, erreur récupérable.
11. Un adapter ne doit terminer un stream que sur un signal de fin fiable ou une
    reconciliation explicite.
12. Les événements de sources et fichiers doivent être rattachés à un turn/run
    précis.
13. Les captures brutes doivent être activables à chaud et limitées par TTL/taille.
14. Toute nouvelle fonctionnalité frontend doit consommer le contrat normalisé, pas
    les détails OpenClaw.
15. Les commentaires/docstrings ajoutés dans le code doivent rester en anglais.

## 28. Critères d'Acceptation Globaux

Le projet peut être considéré prêt pour usage canary si:

1. Un utilisateur peut se connecter via Google.
2. Le backend vérifie le token Firebase.
3. Le routing utilisateur vers instance/agent fonctionne.
4. Un message texte stream en AI SDK UI.
5. Un run long affiche un statut pendant toute la durée.
6. Fermer/recharger le navigateur ne perd pas la réponse finale.
7. Un fichier généré est cliquable sans exposer de path local.
8. Une compaction ne coupe pas le stream prématurément.
9. Un run de suivi est affiché dans la même conversation.
10. Une différence de format olivier/jerome est absorbée par adapter.
11. Les traces Opik/Langfuse contiennent les IDs de corrélation.
12. Les fixtures critiques passent en CI locale.
13. Un bump OpenClaw peut être validé sur fixtures avant activation.

## 29. Décision Finale

L'architecture retenue est:

```text
React + AI SDK UI
  -> FastAPI backend
  -> Pydantic AI VercelAIAdapter
  -> OpenClawAsPydanticAgent
  -> versioned OpenClaw Gateway adapters
  -> OpenClaw Gateway WebSocket
```

Cette architecture respecte les contraintes:

- frontend stable;
- backend robuste;
- OpenClaw utilisé dans son modèle natif WebSocket;
- protocole AI SDK UI maintenu par un tiers;
- versioning OpenClaw maîtrisé;
- multi-instance;
- auth Google;
- reprise des conversations;
- future intégration voice;
- tests par traces réelles.

La première implémentation doit commencer par le spike Pydantic AI +
`VercelAIAdapter.dispatch_request()`, car c'est le point qui valide le contrat le
plus risqué: présenter OpenClaw comme un agent Pydantic AI sans réécrire le
protocole de streaming côté backend.
