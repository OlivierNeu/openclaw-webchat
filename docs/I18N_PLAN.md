# Internationalisation (i18n) — plan & décisions

**État : I18N-2 (fondation) LIVRÉE et vérifiée en live.** Ce document grave les
décisions à respecter pour les phases suivantes (features + migration de masse +
chaînes serveur). Source : recherche I18N-1 + revue advisor de la fondation.

## Framework retenu : Paraglide JS (`@inlang/paraglide-js` v2)

- Compile-time, tree-shaken, **type-safe** : une clé hallucinée = erreur `tsc`
  (c'est l'argument n°1 du choix, à NE PAS casser — voir « chaînes serveur »).
- Catalogues = JSON plat `messages/{locale}.json` (plugin message-format 4.4.0).
  `baseLocale = "fr"`, `locales = ["fr","en"]`.
- Génère `src/paraglide/` (git-ignoré, recompilé par `paraglide:compile`, émet
  aussi les `.d.ts` pour rester strict sans `allowJs`).
  ⚠️ **Piège** : le CLI `paraglide-js compile` ET le plugin Vite écrivent tous deux
  `src/paraglide`. Le CLI **défaut sur la stratégie cookie** si on omet
  `--strategy` → `npm test`/`typecheck` écraseraient la sortie localStorage du
  plugin. Le script `paraglide:compile` DOIT donc passer
  `--strategy localStorage baseLocale` (= le plugin). Vérif :
  `grep -A3 "export const strategy" src/paraglide/runtime.js`.
- Usage : `import { m } from "@/paraglide/messages.js"; m.key({param})`.
- Stratégie : `["localStorage", "baseLocale"]` → premier rendu sans flash (locale
  non définie ⇒ `fr`) ; un switch écrit localStorage + **recharge** la page.
  `setLocale(locale)` / `getLocale()` depuis `@/paraglide/runtime.js`.

## Convention de nommage des clés

`<domaine>_<intention>` en snake_case. Préfixes par domaine :
`chat_*`, `settings_*`, `errors_*`, `admin_*`, `usermenu_*`, `nav_*`,
`notif_*`, `files_*`, `theme_*`, `prefs_*`, `language_*`, et **`common_*`**
pour les chaînes partagées (voir dédup).

## Garde-fous CI (câblés dans `npm test`)

1. **Parité des clés** (`scripts/i18n-check-parity.mjs`) — **hard-fail**.
   `fr.json` et `en.json` doivent définir EXACTEMENT le même jeu de clés.
2. **Ratchet de littéraux** (`scripts/i18n-check-literals.mjs`) — anti-régression.
   Compte les lignes `src` portant un littéral **accentué** (proxy d'une chaîne
   FR non internationalisée) ; échoue seulement si le total **augmente** vs
   `scripts/i18n-literals-baseline.json`. `--update` pour rebaseliner après une
   étape de migration. Baseline initiale = **427**.

   ⚠️ **LIMITE CONNUE (advisor #1) — le ratchet ≠ complétude.** Il est AVEUGLE à
   l'anglais hardcodé (« New chat », « CHATS », « Select or create a chat to
   begin. » sont des chaînes EN à interner ET à passer en FR par défaut, jamais
   vues par le ratchet). Donc `ratchet == 0` ne veut PAS dire « toute l'app
   internationalisée ». La complétude (exigence explicite du user) vient d'un
   **passage par fichier** énumérant TOUTES les chaînes user-facing — texte JSX
   **+** `aria-label` / `title` / `placeholder` / `alt` / props string — accent
   ou pas. Le ratchet n'est qu'un filet anti-régression FR.

## Chaînes serveur / persistées (notifications, erreurs) — décision (advisor #3)

Paraglide est client-only ; les `notifications.title/body`, `messages.error`,
`DISPATCH_FAILURE_MESSAGE` sont écrits en FR à la création ⇒ non retro-traduisibles.

**Refactor : stocker `{ code, params }`, rendre côté client.** MAIS pas via
`m[code](params)` dynamique — ça **casse le tree-shaking ET le typage** (l'argument
n°1 de Paraglide). À la place, **map explicite typée** :

```ts
const NOTIF_RENDERERS = {
  anomaly_opened: (p: { kind: string }) => m.notif_anomaly_opened(p),
  feedback_reply: (p: { ... }) => m.notif_feedback_reply(p),
  // …
} as const;
```

- **Fallback legacy obligatoire** : les rows `notifications` existantes (prod +
  local) n'ont PAS de `code` → rendre le `title/body` stocké si `code` absent,
  sinon elles s'affichent vides.
- Les chaînes assemblées par code (`relativeAge` « 3j » / « 53min ») sont des
  **messages paramétrés** (`m.age_days({n})`), pas des swaps littéraux.

## Sync locale cross-device (advisor #5)

Mirror EXACT du thème (`profiles.themeMode` + `appMeta.defaultThemeMode` +
`me.setThemeMode` + cache localStorage anti-flash seedé par le script inline
d'`index.html`). Pour la locale :

- `profiles.locale` (pref user) + `appMeta.defaultLocale` (défaut admin),
  `me.setLocale` (identity-level, requireUserId).
- **NE PAS** rappeler `setLocale(serverLocale)` + reload à chaque `getMe`
  (risque de **boucle de reload**). Écrire localStorage **synchronement PUIS**
  recharger UNE fois ; après reload `localStorage == serveur` ⇒ la condition ne
  se redéclenche pas.
- Anti-flash = cache `oc.locale` seedé par le script inline, pas un `setLocale`
  post-render.

## Migration de masse (I18N-6) — protocole fan-out (advisor #4)

- **Dédup d'abord** : « Annuler »/« Cancel », « Enregistrer », « Fermer »…
  apparaissent 20× → clés `common_*` partagées. Décider AVANT le fan-out quelles
  chaînes sont mutualisées vs par-composant.
- **Aucun agent parallèle n'édite `fr.json`/`en.json` directement** (writes
  concurrents perdus). Chaque agent retourne du **structuré** `{ key, fr, en, file }` ;
  **un seul étage de synthèse** merge dans les catalogues + lance la parité.
- Seed EN = traduction machine FR→EN, relue.
- Par fichier : remplacer les littéraux par `m.key()`, recompiler, `--update` le
  ratchet, vérifier `tsc` + parité.

## Phases

- ✅ **I18N-1** Recherche framework.
- ✅ **I18N-2** Fondation : Paraglide + FR défaut + EN + sélecteur (UserMenu) +
  2 gates. Pilote vérifié live (switch FR↔EN après reload).
- ✅ **Locale cross-device** (#127) : `profiles.locale` + `appMeta.defaultLocale`
  (schéma additif) + `me.setLocale` (identity-level, audité) + `getMe` résout
  (user→admin→base) + hook `useApplyLocale` (loop-safe via la garde native de
  `setLocale`) + `<html lang>` a11y (script inline + hook). 4 tests Convex.
  Vérifié live : switch via Convex + **test discriminant cross-device** (wipe
  cookie+localStorage → la pref serveur se réapplique) + rendu stable (pas de boucle).
- ✅ **I18N-3** Onglet Fichiers (owner-scoped + filtres) — voir
  [[openclaw-webchat-files-tab]]. PROD : `convex run files:backfillFiles`.
- ✅ **I18N-4** Refonte onglet « Apparence » (ex-Theme showroom) : `AppearancePanel`
  = thème par défaut + **langue par défaut** de l'app (nouveau `admin.setDefaultLocale`,
  mirror `setDefaultThemeMode`) ; showroom replié sous `<details>` (non-i18n, sera
  relocalisé en `/showroom` #23) ; clé d'onglet inchangée `"theme"`, label i18n via
  `TAB_I18N` + `TAB_LABELS.theme="Apparence"`. **Asymétrie (advisor)** : régler la
  langue par défaut RECHARGE la vue d'un admin SANS pref perso (Paraglide) — un
  hint l'explicite ; un admin AVEC pref est protégé (live-confirmé : no-reload).
  Test backend `admin.setDefaultLocale` (requireAdmin + héritage). Tab toujours
  gated `admin.manage`.
- ✅ **I18N-5** Préférences UI en liste **catégorisée + filtre**, internationalisé.
  Registre d'affichage partagé `src/chat/prefsMeta.ts` (`PREF_META` = categorie +
  label/help via `m.*`, remplace `PREF_LABELS`) + helper PUR `groupAndFilterPrefs`
  (fallback **`other`** — une pref sans catégorie ne disparaît JAMAIS ; filtre
  **accent-insensible** NFD, matche aussi le nom de catégorie). Câblé dans les 2
  surfaces : dialog user (checkboxes) + onglet admin « Préférences UI » (selects,
  filtre scopé à la section « Valeurs par défaut » seule ; `voiceInput` réutilise
  `m.pref_voiceInput_label`). 5 tests sur les angles morts (other/accent/vide/
  catégorie/no-match). **NOTE infra** : `vitest.setup.ts` stub `localStorage`
  (env edge-runtime) → tout test important `m.*` résout au baseLocale "fr".
- ✅ **I18N-6** Migration de masse (FR+EN). **Part B** (client) via WORKFLOW
  multi-agents (`i18n-mass-migrate`, 24 fichiers, **612 clés**, 0 collision,
  1 fix : RolesTab `key={g.group()}`). **Part A** (chaînes serveur) à la main :
  `dispatchErrorInfo` (codes déjà serveur → map i18n) + `NotificationBell`
  (chrome + `feedback_reply` rendu via son `kind` = approche `{code}` sans champ
  schéma) + labels d'onglets (`TAB_I18N` total). Ratchet **402 → 40** (reste =
  showroom intentionnel + commentaires FR non-UI + 2 strings SettingsNav).
  **Gates** : tsc 0 · parité 755 clés · 281 tests · build 0.
  **GAPS EN connus** (surface-known-gaps) : (1) notifications **anomalies**
  gardent leur title/body FR stocké (détail serveur dynamique → un admin EN voit
  « Anomalie : … » ; refactor `{code,params}` complet = follow-up) ; (2) ~2 strings
  SettingsNav (« Réglages », « Retour au chat ») + le « Fermer » de la primitive
  Dialog générique ; (3) le showroom (non-i18n, volontaire, → /showroom #23).
- ✅ **I18N-7** Vérif live FR↔EN : **ConvexChat** (38 chaînes) + **ServiceAccounts**
  (48 chaînes) rendus en FR ET EN sans casse + grep des classes fonction-stringifiée
  / sentinel-comparé **clean** + advisor. Méthode = mirror du « render the populated
  thing » (Files) à 24×.
