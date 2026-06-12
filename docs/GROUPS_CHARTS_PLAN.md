# Plan — Groupes, Chartes graphiques & réorganisation des préférences

> Statut : APPROUVÉ (2026-06-09). Référence pour les workflows d'implémentation P2–P5.
> Recherche sécurité import : voir §Sécurité (verdict « CSS only » NON sûr).

## Décisions de design (verrouillées)

1. **Menu compte (UserMenu)** = uniquement le *mode de thème* (light/dark/system) + *Déconnexion*.
   Langue et Préférences UI **migrent dans Settings** (modèle de l'onglet Fichiers : `chats.read`,
   visible à tous, paramless). La modale `PreferencesDialog` est retirée (son contenu est réutilisé
   dans un onglet Settings).
2. **Charte = disponibilité + CHOIX, jamais imposée.** Ensemble disponible d'un user =
   chartes communes (admin) ∪ chartes des groupes dont il est membre ∪ sa charte perso.
   Le user **choisit** dans cet ensemble ; défaut = charte actuelle de l'app.
3. **Vocabulaire de charte = les variables CSS shadcn EXISTANTES** (`src/index.css` :
   `--primary`, `--background`, `--foreground`, `--muted`, `--border`, `--ring`, `--radius`,
   `--shadow-*`, `--font-sans`, `--font-mono`, espacements). Périmètre = **couleurs (light+dark)
   + rayons + ombres + espacements + typographie** (familles de polices **allowlistées**, pas d'upload).
   « Charte actuelle » = valeurs courantes ; une charte client custom (à venir) = une 2ᵉ map de valeurs.
4. **Import = preset JSON de tokens**, validé **par type** côté serveur (couleur / longueur / ombre /
   police-allowlistée) sur un **vocabulaire fermé**. `url()`, `@import`, `@font-face`, `image-set`,
   `expression`, clés inconnues → **REJET**. Appliqué via `setProperty` + `@property`, **jamais**
   concaténé dans `<style>`.
5. **Agents par groupe = union calculée au READ** (dans `enrichUserAgents`), précédence :
   défaut direct `userAgents` > défaut groupe > défaut instance > code. Pas de matérialisation →
   pas de drift, on conserve l'invariant « exactly one isDefault per user ».
6. **Introspection native** : tous les résolveurs renvoient `{ value, source }`
   (`source: "user" | "group:<key>" | "common" | "code"`). L'inspecteur « qui a quoi » n'est qu'un rendu.
7. **Groupes minimaux** : pas de RBAC intra-groupe, pas de soft-delete (non demandés).
   Création/gestion des groupes = **admin uniquement**. Un user peut associer SA charte perso aux
   groupes dont il est membre.

## Modèle de données (nouvelles tables Convex)

- `groups` { key, name, description?, createdBy, createdAt } — index by_key
- `groupMembers` { groupId, userId, joinedAt } — index by_group, by_user, by_user_group (multi-appartenance)
- `charts` { key, name, description?, scope: "common"|"group"|"personal", ownerUserId?, builtin,
  tokens (objet validé par type), createdBy, createdAt } — index by_owner, by_scope, by_key
- `groupCharts` { groupId, chartId } — M:N disponibilité — index by_group, by_chart
- `groupAgents` { groupId, instanceName, agentId } — M:N partage agents — index by_group, by_instance, by_group_instance
- Réutilise les crochets **déjà réservés** : `profiles.themeName` = charte sélectionnée par le user ;
  `appMeta.defaultThemeName` = charte par défaut globale.

### Cascades à câbler
- Suppression d'un **groupe** → purge `groupMembers` + `groupCharts` + `groupAgents` (1 mutation, audit).
- Suppression d'un **user** → purge ses `groupMembers` + ses chartes perso (+ cascades existantes).
- Suppression d'une **instance** → purge `groupAgents` de cette instance (en plus de `userAgents`).
- Suppression d'une **charte** associée à des groupes → purge `groupCharts` ; un user dont
  `profiles.themeName` pointe la charte supprimée retombe sur le défaut (jamais d'erreur).

## RBAC (extension)

- Nouvelles permissions : `groups.manage` (admin), `charts.manage` (admin : chartes communes +
  assoc à n'importe quel groupe), `charts.create` (user : importer sa charte perso + l'associer à
  SES groupes). Lecture des chartes via `chats.read` (tous).
- Commune → modif/suppr **admin seul**. Perso → **owner + admin**.
- Gating serveur (`requirePermission`, identité RÉELLE) + masquage d'onglet client.
- `charts.create` / la gestion d'assoc user→groupe utilise l'identité **effective** (impersonation-aware)
  pour les données, **réelle** pour la permission — même split que les autres reads owner-scoped.

## Sécurité de l'import (durci — sources : OWASP WSTG, PortSwigger, bug bounty OAuth réel, CVE-2026-41305)

Verdict : **« CSS only » n'est PAS sûr.** Du CSS pur permet exfiltration de tokens (`url()`+sélecteurs,
`:has()`, `@import` séquentiel, `@font-face`+`unicode-range`), clickjacking/phishing in-app, et XSS
indirecte si re-sérialisé dans `<style>`. Les vecteurs JS-via-CSS legacy (`expression()`, `-moz-binding`,
`behavior:`) sont morts. ⇒ **on n'accepte JAMAIS de CSS brut**, seulement des tokens typés.

- Validateur serveur **allowlist par TYPE** (parsing type-checké, p.ex. css-tree) sur vocabulaire fermé ;
  rejet de toute valeur portant URL / at-rule / `;{}` / commentaire / `var()` inattendu / scheme.
- `@property` (typage navigateur) en défense en profondeur.
- **CSP templatée au boot** (entrypoint Caddy, depuis `CONVEX_URL`) — ⚠️ DOIT inclure l'origin Convex
  dans `connect-src`/`img-src`/`font-src` sinon casse le WS Convex + downloads storage.
  `style-src 'self'`, `frame-ancestors 'none'`.
- Tests d'attaque obligatoires : exfil `url()`, `@import`, `@font-face`, mauvais type, clé inconnue → tous rejetés.

## Introspection

Écran admin « Accès & provenance » : sélectionner un user → ses groupes, ses chartes disponibles
(avec provenance commune/groupe/perso), ses agents disponibles (direct/groupe), ses permissions effectives.
Alimenté par les résolveurs `{ value, source }` (pas un inspecteur bolt-on).

## Séquençage & orchestration

- **P1 — Reorg menu + langue/prefs → Settings** : exécuté **directement** (pas de workflow). Gate.
- **P2 — Fondations** : groupes (tables + admin CRUD + membership) + extension RBAC + agents-par-groupe
  (union au read) + résolveurs introspectables `{value,source}`. *(workflow)*
- **P3 — Chartes** : vocabulaire tokens, table `charts`, résolution disponibilité+sélection, application
  runtime (`setProperty`/`@property`), onglet « Apparence » refondu (sélecteur de charte), RBAC chartes,
  assoc charte↔groupe. *(workflow ; dépend de P2)*
- **P4 — Import sécurisé** : validateur tokens typés + `@property` + CSP templatée Caddy + tests d'attaque.
  *(workflow ; dépend de P3)*
  - ⚠️ **Hérité de P3, à RE-EXAMINER en P4** : `resolveChart` applique le défaut admin global
    (`appMeta.defaultThemeName`) SANS vérifier la disponibilité. Bénin en P3 (chartes builtin =
    couleurs pures). Mais dès que P4 ajoute des chartes **custom/personal**, ce chemin laisserait
    un admin pousser la charte perso d'un user comme défaut global à tous → ajouter un check (le
    défaut global ne peut être qu'une charte commune/builtin, pas une perso d'autrui).
- **P5 — Introspection UI** : écran « qui a accès à quoi » (provenance). *(workflow ; dépend de P2+P3)*

Chaque workflow : implémenteurs en fan-out (schéma / backend Convex / frontend / tests) → **red team
adversarial** (sécurité, RBAC, invariants, régression) → **boucle jusqu'au vert**
(tsc 0 · parité i18n · ratchet · tests · build) → revue. **Gate + advisor entre les phases.**
Toute nouvelle chaîne UI : i18n FR + EN.

## Hors scope

- Implémentation d'une charte client spécifique (map de valeurs dans le vocabulaire P3, plus tard).
- Imposition de charte par groupe, RBAC intra-groupe, soft-delete.
