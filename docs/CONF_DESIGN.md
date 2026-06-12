# CONF-3 — Design : le système de configuration du webchat

> Fondé sur `CONF_RESEARCH.md` (25 claims vérifiés + autopsie Control UI +
> règles widgets) et `CONF_CAPABILITIES.md` (surface RPC 6.5 réelle). Principe
> Olivier : épuré au travail, capable en profondeur, **aucune capacité
> OpenClaw perdue *ou explicitement déléguée au Control UI/CLI* (liste §7)**.
> Chaque choix cite sa prescription.
> **Statut : GO-avec-corrections (red-team 2026-06-11). Les amendements
> ci-dessous PRÉVALENT sur le corps du document.**

## ⚠ Amendements normatifs (verdict red-team, 17 findings)

**A1 (P1) — Provenance v1 = BINAIRE, fondée sur l'intent Convex.** La présence
de la clé dans `sessionSettings` (l'intent) = « modifiée ici » ; absence =
« héritée ». Le NOMMAGE du niveau source (« agent X » vs « défaut admin »)
n'est promis qu'après un probe RPC (que retournent `sessions.get`/`describe` ?)
— le bridge ne ré-implémente JAMAIS la cascade de résolution du gateway
(drift garanti). Au passage : corriger l'heuristique actuelle de
`ConvexChat.tsx` (`inherited = valeur === défaut` est FAUSSE quand on
override à la valeur du défaut).

**A2 (P1) — ↺ conditionné au probe d'unset.** Rien ne garantit que
`sessions.patch` sache désappliquer un override (et le bridge ré-applique
l'intent à chaque tour). Probe au banc obligatoire AVANT d'implémenter ↺.
Si unset impossible : pas de ↺ par ligne en v1 (jamais de « faux override »
qui patcherait la valeur du défaut).

**A3 (P1) — RBAC fichiers scindé règles/mémoire.** `agents.files.read`
(grantable) ne couvre QUE AGENTS.md/SOUL.md/IDENTITY.md/TOOLS.md.
MEMORY.md, USER.md, BOOT*, restent admin-only (les agents sont partagés
entre utilisateurs : la mémoire contient des données d'autrui). Filtrage
côté Convex/bridge, pas côté UI.

**A4 (P1) — Édition de fichiers : diff + rollback + anti-concurrence.**
Audit UI-9 avec contenu avant/après COMPLET (20k max = trivial),
confirmation-avec-diff avant save, compare-and-set (re-`get` avant `set`,
abort si changé). Dans le périmètre de CONF-4c.

**A5 (P2) — Réflexion : SEGMENTED, pas slider.** Retrait du cran « défaut »
(l'héritage passe par badge+↺, pas par une pseudo-valeur sur une échelle
ordinale). Sheet → segmented 6 options ; popover → segmented compact ;
slider 6 crans seulement en dernier recours d'espace, valeur AU-DESSUS.

**A6 (P2) — Section « VOIX bientôt » SUPPRIMÉE de 4b.** Pas de dead UI dans
un panneau quotidien. La capacité est préservée dans CONF_CAPABILITIES ;
CONF-4e l'ajoutera entière et fonctionnelle.

**A7 (P2) — CONF-4d dégonflé.** Pas de moteur JSON-Schema pour 4 champs :
formulaire codé en dur (thinkingDefault, fastModeDefault), VALIDÉ contre
`config.schema` à l'exécution. verboseDefault (no-op : épinglé full) et
elevatedDefault (défaut sécurité) retirés du v1. Phase candidate au report.

**A8 (P2) — reasoningLevel : probe footgun avant exposition** (même famille
de risque que verbose : peut casser l'affichage du raisonnement/streaming).
Lecture seule ou valeurs contraintes si le banc révèle un piège.

**A9 (P2) — Une SEULE release bridge en tête de chantier** (le bridge est un
repo + image séparés depuis la componentization) : tous les endpoints +
allowlists d'un coup, puis les phases ne livrent que du front/Convex.
Annoter chaque phase de son tier de déploiement.

**A10 (P2) — Dépendance explicite à `MULTI_AGENT_REDESIGN.md`** : l'écran
« par agent » consomme le registre d'agents du redesign (clé instance+agentId),
pas un registre inventé.

**A11 (P2) — Grammaire §1 complétée** : état « application… » par ligne,
timeout + erreur inline avec retry (aligné failDispatch) ; composant de
réglage PARTAGÉ entre pill et Sheet (jamais deux implémentations) ; confirm
sur Réinitialiser/Compacter ; i18n `m.key()` + tests unitaires de TOUTES les
branches des messages paramétrés de provenance (leçon GC-P5) ; Sheet → drawer
plein écran mobile ; tokens de charte (P3/P4) pour barre/gauges ; liste de
fichiers DYNAMIQUE (`agents.files.list`).

**A12 (P3) — Phases corrigées** : 4a = fastMode + provenance binaire dans le
popover (reasoningLevel attend 4b/probe) ; `/session-usage` seulement si
sessionMeta (`totalTokens`/`estimatedCostUsd` déjà au schéma) ne suffit pas.

## 0. Concept directeur : « trois horizons, une seule grammaire »

Trois horizons de configuration, chacun à SA place dans l'espace visuel,
reliés par une grammaire commune (libellés front-loadés, provenance visible,
réinitialisation par item) :

| Horizon | Fréquence | Surface | Mécanisme |
|---|---|---|---|
| **Par chat** | quotidienne | pill du composer + panneau de session (droite) | `sessions.patch` |
| **Par agent** | hebdomadaire | Settings ▸ Agents ▸ [agent] | `agents.files.*`, `agents.update` |
| **Global** | rare (admin) | Settings ▸ Défauts de chat | `config.patch` piloté par `config.schema` |

Pourquoi : le split par fréquence d'usage réelle est LA règle de la
progressive disclosure (CONF_RESEARCH §11) ; le Control UI échoue précisément
en mélangeant les trois horizons dans un popover de composer.

## 1. La grammaire commune (s'applique partout)

1. **Ligne de réglage** : `Libellé fort` à gauche (mot porteur en premier —
   « Réflexion », pas « Niveau de réflexion ») ; contrôle à droite de la même
   ligne ; description d'une ligne max, grise, dessous.
2. **Provenance — pattern VS Code étendu à notre cascade** :
   - barre verticale accent sur le bord gauche = **modifié à ce niveau** ;
   - badge texte discret quand hérité : `héritée · agent Olivier` ou
     `défaut admin` (on généralise notre badge « héritée » existant) ;
   - action `↺` par ligne = revenir à l'héritage (efface l'override, ne remet
     PAS une valeur codée en dur).
3. **Widgets par les seuils mesurés** (CONF_RESEARCH §widgets) :
   - ≤ 5 choix → segmented control (Vitesse : Défaut/Rapide/Standard ; Modèle
     quand ≤ 4 routés ; Raisonnement : Off/On/Stream) ;
   - Réflexion (7 dont Défaut) → **slider à crans étiquetés** (échelle ordonnée
     visible, étiquette au-dessus du curseur) — jamais un dropdown qui cache
     l'ordre ;
   - Voix (~10) → dropdown avec préécoute ; valeurs ms (VAD, délais) →
     input + stepper avec unité affichée, jamais un slider seul.
4. **Sections layer-cake** : en-têtes de section en capitales espacées,
   1 colonne, jamais de grille multi-colonnes de réglages.
5. **Actions ≠ réglages** : les actions (Compacter, Réinitialiser la session,
   Actualiser) vivent dans une zone « Actions » séparée en bas de panneau —
   jamais mélangées aux réglages (anti-pattern n°7 du Control UI).
6. **Max 2 niveaux de divulgation** : surface → panneau. Aucun sous-panneau
   dans un panneau.

## 2. Horizon « par chat »

### 2.1 La pill du composer (le fréquent, accessible en 1 clic)
La chip actuelle `GPT-5.5 · High` ouvre UN popover (pas de sous-menus
imbriqués — anti-pattern n°6 du Control UI) :

```
┌──────────────────────────────────────────┐
│ MODÈLE                                   │
│ ┌─────────┬─────────┐                    │
│ │ GPT-5.5*│ 5.4-Mini│   héritée · agent  │
│ └─────────┴─────────┘                    │
│ RÉFLEXION                       High ↺   │
│ ○──○──○──○──●──○──○                      │
│ off min low med high xhigh défaut        │
│ VITESSE                                  │
│ ┌────────┬────────┬──────────┐           │
│ │ Défaut*│ Rapide │ Standard │           │
│ └────────┴────────┴──────────┘           │
│ ──────────────────────────────────────   │
│ ⚙ Tous les réglages de session →         │
└──────────────────────────────────────────┘
```
- Modèle : liste = `models.list` filtrée aux modèles ROUTÉS de l'agent (notre
  acquis — jamais le namespace provider fuité, anti-pattern n°5).
- « Tous les réglages → » ouvre le panneau de session (le 2ᵉ et dernier
  niveau de divulgation).

### 2.2 Le panneau de session (Sheet latéral DROIT)
Zone droite = emplacement naturel du secondaire (biais 80/20, CONF_RESEARCH
§1). Colonne unique, sections layer-cake :

```
╔═ Réglages de session ════════════════╗
║ GÉNÉRATION                           ║
║ ▌Modèle        [GPT-5.5 ▾]      ↺    ║   ▌= override session (barre accent)
║  Réflexion     ○─○─○─●─○─○  High     ║   héritée · agent Olivier
║  Vitesse       [Défaut|Rapide|Std]   ║   héritée · défaut admin
║  Raisonnement  [Off|On|Stream]       ║   visibilité du raisonnement
║                                      ║
║ SESSION                              ║
║  Contexte      ████████░░ 53 %       ║   145,1k / 272k jetons
║  Verbosité     full · fixée          ║   requise par le streaming
║  Coût          ~0,00 $ · 26k jetons  ║   (sessions.usage)
║                                      ║
║ AGENT                                ║
║  Olivier · codex · gpt-5.5           ║
║  Fichiers de l'agent →               ║   (lien Settings, si permission)
║                                      ║
║ VOIX                          bientôt║
║  Le mode vocal arrive — transport,   ║
║  voix et sensibilité se régleront ici║
║ ────────────────────────────────────║
║ ACTIONS                              ║
║  [Compacter le contexte]             ║
║  [Réinitialiser la session]          ║
╚══════════════════════════════════════╝
```
- Nouveaux write-backs : `fastMode` (Vitesse), `reasoningLevel` — extension
  directe d'UI-3 (mêmes garanties : write-back → sessionMeta echo → UI).
- Usage/coût : `sessions.usage` (nouvelle remontée bridge, read-only).
- La section VOIX est **présente mais inerte** tant que Talk n'est pas câblé :
  on annonce la capacité (rien n'est perdu), on ne ment pas sur l'état.
- `elevatedLevel`, `providerOverride`, `authProfileOverride`, `sendPolicy` :
  délibérément ABSENTS de l'UI utilisateur (fréquence ~nulle + risque) ;
  restent accessibles à l'admin via l'horizon global. Rien n'est perdu,
  tout est à sa place.

## 3. Horizon « par agent » — Settings ▸ Agents ▸ [agent]

Reprend l'excellente idée du Control UI (workspace files visibles) en la
complétant : ÉDITION, garde-fous et audit.

```
Settings ▸ Agents ▸ Olivier
┌──────────────────────────────────────────────┐
│ FICHIERS DE L'AGENT                          │
│  AGENTS.md     9,2 ko ▓▓▓▓▓░ 46 %   Éditer   │  gauge = bootstrapMaxChars
│  SOUL.md       1,4 ko ▓░░░░░  7 %   Éditer   │
│  MEMORY.md    16,9 ko ▓▓▓▓▓▓ 85 % ⚠ Éditer   │  ⚠ près de la limite
│  …                                           │
│  Budget total : 30,8k / 60k (51 %)           │
│                                              │
│ DÉFAUTS DE L'AGENT                           │
│  Réflexion par défaut   [High ▾]             │
│  Vitesse par défaut     [Défaut|Rapide|Std]  │
└──────────────────────────────────────────────┘
```
- Éditeur : plein écran (Dialog), markdown avec Aperçu / Source (pattern
  Control UI conservé), compteur de caractères vs limite EN DIRECT, save
  explicite → `agents.files.set` via bridge, **audit UI-9** à chaque écriture
  (qui, quand, quel fichier, delta de taille).
- Les gauges répondent à un problème RÉEL (le doctor NAS a signalé MEMORY.md
  à 86 % — l'utilisateur ne le voit jamais aujourd'hui).
- RBAC : nouvelle permission `agents.files.manage` (read peut être plus
  large : `agents.files.read` pour « l'utilisateur averti qui vérifie les
  règles » — la motivation d'Olivier). Write = admin par défaut, grantable.

## 4. Horizon « global » — Settings ▸ Défauts de chat (admin)

- Piloté par **`config.schema`** (le gateway publie son JSON Schema + hints
  UI) : le formulaire se construit depuis le schéma de LA version connectée —
  zéro hardcode par version, les nouveautés (ex. futurs champs) apparaissent
  seules. On n'expose que le sous-arbre `agents.defaults.{thinkingDefault,
  fastModeDefault, verboseDefault, elevatedDefault}` + Talk (plus tard) ;
  le reste de openclaw.json reste du ressort du Control UI/CLI (périmètre
  maîtrisé, pas un clone de l'éditeur de config).
- Écriture via `config.patch` (scope admin du bridge), confirmation explicite,
  audit.

## 5. Architecture technique (extension, pas refonte)

```
UI (pill/Sheet/Settings)
  └─ Convex mutations (RBAC réel + audit)        [pattern UI-3 existant]
      └─ bridge endpoints (allowlist par champ)
          ├─ /patch         → sessions.patch     [existant ; + fastMode,
          │                                       reasoningLevel]
          ├─ /agent-files   → agents.files.list/get/set   [NOUVEAU]
          ├─ /session-usage → sessions.usage     [NOUVEAU, read-only]
          └─ /config        → config.get/schema/patch     [NOUVEAU, admin]
```
- Le bridge garde une **allowlist de champs** par endpoint (jamais de
  passthrough générique) — même discipline que le body-routing P2a.
- Provenance : le bridge remonte la cascade résolue dans sessionMeta (la doc
  6.5 documente l'ordre de résolution — `tools/thinking.md`) ; l'UI ne devine
  jamais.

## 6. Phases d'implémentation

| Phase | Contenu | Dépendances |
|---|---|---|
| CONF-4a | `fastMode` + `reasoningLevel` dans le popover existant + provenance généralisée (badge+barre+↺) | aucune (extension UI-3) |
| CONF-4b | Panneau de session (Sheet droite) + usage/coût + actions séparées | 4a |
| CONF-4c | Workspace files (bridge `/agent-files` + RBAC + audit + éditeur gauges) | aucune |
| CONF-4d | Défauts admin schéma-pilotés (`config.schema`/`config.patch`) | aucune |
| CONF-4e | Section Voix réelle (après câblage Talk : `talk.catalog`, transport, voix, VAD) | chantier Talk |

## 7. Ce qu'on refuse délibérément (et pourquoi)
- Pas de grille horizontale de réglages au composer (anti-patterns n°1-2).
- Pas de champ texte libre pour le modèle (n°4) — toujours la liste routée.
- Pas de 3ᵉ niveau de divulgation (CONF_RESEARCH §10).
- Pas d'éditeur de config JSON brut côté utilisateur (le webchat n'est pas le
  Control UI ; l'admin garde CLI/Control UI pour l'exotique).
- Pas de slider pour des valeurs exactes en ms (règle widgets).
