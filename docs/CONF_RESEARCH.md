# CONF-1 — Fondation scientifique : interface de configuration d'exception

> Deep-research 2026-06-11 (105 agents, 23 sources, 113 claims extraits, 25
> vérifiés adversarialement → **25 confirmés, 0 réfuté**). Fondation du design
> CONF-3. Corpus dominant : NN/g (recherche primaire eye-tracking), Baymard,
> IEEE/CHI, doc VS Code.

## Prescriptions vérifiées (haute confiance)

### Science du regard
1. **Le biais gauche est massif** : ~80 % des fixations tombent sur la moitié
   gauche de l'écran (130 000+ fixations) ; les écrans larges ne redistribuent
   PAS l'attention (1024→1920 px : le pic ne bouge que de ~400→~600 px du bord
   gauche). → Navigation en haut ou à gauche ; contenu prioritaire « front and
   center » ; **un panneau latéral droit est l'emplacement naturel des
   contrôles SECONDAIRES/avancés, pas des primaires**.
2. **Le F-pattern est un anti-pattern conditionnel, pas une loi à exploiter** :
   il n'apparaît que sur du texte mal formaté + recherche d'efficacité + faible
   motivation, et il fait sauter tout ce qui est à droite. On le « designe
   away » par le formatage — un panneau de réglages qui déclenche un scan F est
   un panneau raté.
3. **Le scan « layer-cake » (en-têtes → saut du corps) est la stratégie la plus
   efficace documentée** (classement NN/g : F < spotted < layer-cake <
   commitment). → Structurer le panneau avec des **en-têtes de section
   significatifs** pour l'induire.
4. **Personne ne lit mot à mot** : explications courtes, scannables,
   front-loadées (les premiers mots du libellé portent l'information).
5. Labels de formulaire (nuance, confiance moyenne) : alignés à gauche =
   remarqués le plus vite, MAIS top-aligned reste le meilleur compromis global
   (fixations + complétion, Penzo 2006). Ne pas utiliser l'infield/placeholder
   comme label (contredit la guidance anti-placeholder).

### Charge cognitive
6. **Colonne unique** > multi-colonnes pour les formulaires (NN/g + Baymard +
   CXL n=702 : 15,4 s plus rapide, significatif). Exception : 2-3 champs
   conceptuellement liés sur une ligne.
7. **Chunking en sections étiquetées** : double mécanisme vérifié (scan
   efficace + une catégorie cognitive à la fois). Listes plates d'options =
   anti-pattern.
8. **La surcharge fait abandonner** : erreurs, submersion, abandon (Baymard :
   ~26 % d'abandons de checkout dus à la seule complexité).

### Progressive disclosure (validation directe du panneau « avancé »)
9. **C'est LA méthode prescrite** : différer les options avancées/rares améliore
   apprenabilité, efficacité, taux d'erreur (3 des 5 composantes de Nielsen ;
   ancrage Carroll & Carrithers 1984).
10. **Maximum 2 niveaux de divulgation** (au-delà : les utilisateurs se perdent
    — corroboré par Larson & Czerwinski CHI 1998 : 2 niveaux battent 3).
11. **Le split initial/avancé se décide par la FRÉQUENCE D'USAGE RÉELLE, pas
    par la complexité perçue** : tout ce qui est fréquent doit être visible
    d'emblée. Enterrer un contrôle fréquent derrière « Avancé » est LE mode
    d'échec canonique. (Exception : items rares-mais-critiques type sécurité.)
    Éviter l'onglet « Advanced » fourre-tout.

### Provenance des valeurs (héritée vs modifiée)
12. **Pattern de référence : VS Code Settings** — barre colorée sur le bord
    gauche de chaque réglage modifié (≠ défaut) + filtre `@modified`.
    Directement réutilisable pour notre cascade défaut-code → défaut-admin →
    override-user → override-par-chat.

## Caveats honnêtes
- Le corpus eye-tracking porte sur des pages de CONTENU, et la recherche
  colonne-unique sur des formulaires linéaires — l'application aux panneaux de
  réglages est une inférence raisonnable corroborée, pas une mesure in situ.
- NN/g = recherche primaire de qualité mais non peer-reviewed ; la règle des
  2 niveaux est une heuristique experte corroborée par CHI 1998.
- Aucune étude eye-tracking 2025-2026 spécifique aux UIs de config d'IA n'a
  survécu à la vérification.

## Trous à combler au design (CONF-3)
1. ~~État de l'art produits~~ → **comblé** : autopsie Control UI 6.5 en annexe
   ci-dessous (première main, 11 captures).
2. ~~Widgets~~ → **comblé** : règles dépouillées des 5 sources (section
   « Règles de choix des widgets » ci-dessous).
3. Densité optimale d'un panneau « avancé » : pas de mesure sur settings réels
   (Cloudscape : « comfortable » par défaut, compact réservé au data-intensif,
   bascule cohérente app-wide — pas de chiffres).
4. Inline editing markdown + cascades de provenance au-delà de VS Code
   (JetBrains, Obsidian, GitHub) : précédents à documenter si besoin.

## Règles de choix des widgets (sources dépouillées 2026-06-11)
Seuils NN/g (les seuls chiffrés) + Speero (n=708) + Baymard (tests e-commerce) :
- **≤ 5 options, sélection unique → radio/segmented control** (jamais un
  dropdown) : toutes les options visibles, décision plus rapide — mesuré
  **2,5 s plus vite** que le select (Speero, significatif à 95 %).
- **5–15 options → dropdown** (espace limité + bon défaut existant) ou listbox
  (si l'espace existe et qu'on veut encourager l'exploration).
- **15+ → listbox** à options visibles, ou champ texte si la valeur est connue.
- **Slider** : SEULEMENT quand l'à-peu-près suffit (sensibilité, volume).
  Anti-patterns mesurés : double-poignée mal interprétée par **> 50 %** des
  participants (Baymard) ; étiquette sous le pouce ; valeur précise au slider =
  tâche motrice difficile (NN/g). Si slider numérique : échelle adaptée à la
  distribution + **champ texte obligatoire à côté** + feedback < 250–500 ms.
- **Valeur numérique exacte (ms, seuils) → input + stepper**, jamais un slider
  seul.
- Cas particulier « 6 niveaux ordonnés » (notre Réflexion) : segmented si la
  place le permet ; sinon slider **discret à 6 crans étiquetés** (chaque cran
  est une valeur nommée, étiquette au-dessus) — un dropdown cacherait l'échelle
  ordonnée.
- Densité : « comfortable » par défaut ; ne jamais compacter pour caser plus
  de widgets.

**Application à nos paramètres** : Modèle (2-5) → segmented/radio ; Vitesse
(3 : défaut/rapide/standard) → segmented ; Réflexion (6) → segmented ou slider
à crans ; Voix (~10) → dropdown ; Sensibilité (continue) → slider simple
valeur affichée ; VAD/délais ms → input+stepper.

## Annexe — État de l'art de première main : autopsie du Control UI 6.5
> Analyse heuristique (captures du 2026-06-11, instance olivier) jugée contre
> les prescriptions vérifiées ci-dessus. Comble le trou n°1. C'est la
> « référence négative » du design CONF-3 — chaque défaut est une opportunité.

**Ce que le Control UI fait de BIEN (à retenir) :**
- Workspace files visibles dans un panneau latéral DROIT (zone secondaire ✓
  conforme au biais 80/20) avec taille de fichier, Markdown Preview
  « sanitized » + « View Raw Text » — l'utilisateur averti peut auditer les
  règles données au LLM (AGENTS.md, SOUL.md…). L'idée est excellente, à
  reprendre en mieux (édition + diff + provenance).
- Context meter « 53% context used 145.1k/272k » toujours visible au composer.
- Disclosure « Advanced ⌄ » à 1 seul niveau (≤ 2 ✓).

**Les défauts mesurables (contre les prescriptions) :**
1. **Panneau composer étalé en GRILLE HORIZONTALE** (Voice | Model |
   Sensitivity | Advanced) → viole colonne-unique ; « Advanced » déverse
   6 champs en 2 rangées × 3 colonnes.
2. **Zéro chunking cognitif** : Provider/Transport (réseau), Exact
   VAD/Pause/Lead-in (audio), Reasoning (LLM) — 3 catégories mentales
   mélangées dans la même grille sans en-tête de section → layer-cake
   impossible, scan F garanti.
3. **Champs numériques nus** : « 0.5 », « 500 », « 300 » sans unité, sans
   borne, sans explication (Exact VAD = seuil ? secondes ?). Viole
   « explications courtes front-loadées ».
4. **Labels faibles et redondants** : « Voice / Default » + « Default » dans
   le select = la même info 2 fois ; « Model: Auto » en input texte libre
   sans affordance ni validation visible.
5. **Menu MODEL pollué** : « Default (GPT-5.5 · openai) », « gpt-mini »,
   « GPT-5.5 · openai », « gpt-5.4-mini », « gpt-5.5 · openai-codex » —
   casse incohérente, namespace provider fuité à l'utilisateur, entrée
   legacy morte (openai-codex sans auth) sélectionnable → erreur garantie.
6. **Profondeur de popover** : MODEL → sous-menu latéral → REASONING+SPEED
   dans un 2e popover : 2 niveaux de menus imbriqués au composer (limite
   atteinte) sans persistance visuelle du choix.
7. **« PARAMÈTRES DE CHAT » en chips-boutons** (Actualiser / « Mode
   défil… » tronqué / Réflexion / Outils / Historique) : libellé tronqué,
   mélange d'ACTIONS (actualiser) et de RÉGLAGES (réflexion) dans le même
   popover — catégories cognitives confondues.
8. **Aucune provenance** : impossible de voir si une valeur est un défaut
   d'agent, un héritage de config, ou un override de session (notre badge
   « héritée » sur Réflexion fait déjà mieux).

**Ce que NOTRE webchat fait déjà mieux** (acquis UI-3/UI-5) : panneau Avancé
unifié réflexion/modèle (liste filtrée aux modèles réellement routés),
badge de provenance « héritée », verbosité expliquée, chips d'état dans le
header, context meter via sessionMeta.

## Implications directes pour notre design (résumé opérationnel)
- Réglages **fréquents** (modèle, réflexion) : visibles d'emblée, haut-gauche
  du panneau, labels front-loadés.
- Réglages **avancés** (speed, verbose, transport voice, workspace files) :
  1 seul niveau de disclosure, sections layer-cake, colonne unique.
- **Provenance partout** : barre/badge « héritée / défaut admin / modifiée »
  (on a déjà le badge « héritée » sur Réflexion — généraliser le pattern
  VS Code).
- Défauts admin dans Settings + override par chat = la cascade existante des
  UI-prefs, étendue aux paramètres de session.
