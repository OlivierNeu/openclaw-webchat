# P3 — Spec technique (CONTRAT d'implémentation) — Chartes graphiques

> Périmètre STRICT P3 = SÉLECTION/APPLICATION de chartes BUILTIN (registre code) +
> disponibilité (commune / restreinte-à-groupes) + onglet Apparence refondu + RBAC.
> **Interdit en P3** (= P4) : tout ÉDITEUR ou IMPORT de charte, toute table `charts`
> de chartes custom, tout validateur de tokens user-supplied, CSP, @property strict.
> Une charte est définie ENTIÈREMENT en code (constantes), donc AUCUNE entrée
> non-fiable en P3.

## 0. Probe préalable (DÉJÀ FAIT — résultats figés)

Tailwind v4 `@theme inline` : un override runtime de `documentElement.style` —
- **couleurs** (`--background`, `--foreground`, … `--sidebar-*`, `--chart-*`) : **MARCHE** ;
- **`--radius`** : **MARCHE** (natif) ;
- **typo** : `--font-sans`/`--font-mono` étaient des valeurs littérales inlinées →
  override NO-OP. **DÉJÀ CORRIGÉ dans `src/index.css`** : base vars `--ui-font-sans` /
  `--ui-font-mono` dans `:root`, et `@theme inline { --font-sans: var(--ui-font-sans); … }`.
  Override de `--ui-font-sans` marche (live-verified). **Ne PAS retoucher ce point.**

## 1. Vocabulaire de tokens (FIGÉ par la probe)

`src/index.css` `:root` (light) + `.dark` (dark). Une charte override les VARS DE BASE,
JAMAIS les mappings `@theme inline` (`--color-*`, `--radius-md`).

- **COLOR_TOKENS (mode-scopés — 2 sets light+dark):** background, foreground, card,
  card-foreground, popover, popover-foreground, primary, primary-foreground, secondary,
  secondary-foreground, muted, muted-foreground, accent, accent-foreground, destructive,
  destructive-foreground, border, input, ring, chart-1..5, sidebar, sidebar-foreground,
  sidebar-primary, sidebar-primary-foreground, sidebar-accent, sidebar-accent-foreground,
  sidebar-border, sidebar-ring.
- **SHAPE (mode-indépendant):** `radius` → `--radius`.
- **TYPO (mode-indépendant):** `fontSans` → `--ui-font-sans`, `fontMono` → `--ui-font-mono`.

ChartTokens shape:
```ts
type ChartTokens = {
  colors: { light: Partial<Record<ColorToken,string>>; dark: Partial<Record<ColorToken,string>> };
  radius?: string;
  fontSans?: string;
  fontMono?: string;
};
```
A chart may define a SUBSET; unset tokens fall back to index.css (`removeProperty`).

## 2. Builtin registry = CODE (no DB, no seed/backfill)

`convex/lib/charts.ts` — a PURE TS module (constants + types, no Convex runtime), so it
is importable by BOTH the Convex backend AND the frontend (`src/`). If the frontend
cannot import from `convex/` under the build config, fall back to a single shared module
under `src/lib/` re-exported by a thin `convex/lib/charts.ts`, with a cohesion test — but
TRY the single-source import first.

```ts
export const BUILTIN_CHARTS: ReadonlyArray<{ key: string; name: string; tokens: ChartTokens }> = [
  // 2–3 GENERIC demo palettes (NOT Ataraxis — that is a later, separate task).
  // e.g. "ocean" (cool blue/teal), "forest" (green), "dusk" (violet/amber).
  // Each defines light + dark color sets (oklch), optionally radius/fontSans.
];
export const BUILTIN_CHART_KEYS: ReadonlySet<string>;
export function builtinChart(key: string): {…} | undefined;
```
- `null` selection = NATIVE default look (no chart row needed — `removeProperty` everywhere).
  Do NOT add a "Default" registry entry (it would drift from index.css).

## 3. Data model (P3 = groupCharts ONLY; the `charts` custom table is P4)

- NEW `groupCharts` { groupId: v.id("groups"), chartKey: v.string(), createdAt: v.number() }
  — indexes `by_group`, `by_chart` (["chartKey"]). Parallel to `groupAgents`.
- REUSE `profiles.themeName` (already reserved) = the user's SELECTED chart key (null=default).
- REUSE `appMeta.defaultThemeName` (already reserved) = global default chart key (null=native).
- Availability convention (NO scope column for builtins): a builtin is **common** (available
  to ALL) UNLESS it has ≥1 `groupCharts` row, in which case it is **restricted** to members of
  those groups. (Custom personal/common charts + a `charts` table arrive in P4.)

### Cascades
- `deleteGroup` (groups.ts) → ALSO purge `groupCharts` by_group (alongside members + agents).
- `admin.deleteInstance` → unaffected (charts aren't instance-scoped).

## 4. Backend

`convex/charts.ts` (NEW):
- `listMyCharts()` (effective user, `requireUserId`) → the charts AVAILABLE to the user:
  every common builtin + every restricted builtin whose `groupCharts` intersects the user's
  memberships (via `listMyGroups`/groupMembers by_user). Returns
  `[{ key, name, via: "common" | { group: <key> } }]` (provenance for P5).
- `setMyChart({ name: string | null })` (effective user) → validates `name` is null OR in the
  user's AVAILABLE set (REJECT otherwise — a user can't select a chart not offered to them);
  writes `profiles.themeName`; audited.
- `listChartsAdmin()` (`requirePermission(CHARTS_MANAGE)`) → every builtin with its restriction
  state `{ key, name, restrictedToGroups: [{groupId,key,name}] | null (=common), isGlobalDefault }`.
- `setDefaultChart({ name: string | null })` (CHARTS_MANAGE) → `appMeta.defaultThemeName`.
- `assignChartToGroup({ groupId, chartKey })` / `removeChartFromGroup({ groupId, chartKey })`
  (CHARTS_MANAGE) → groupCharts dedup (`by_chart` filtered by group, or a `by_group_chart`
  index), audited. Reject an unknown chartKey (not in BUILTIN_CHART_KEYS).
- `getMe` (me.ts) → add `chartKey` (user pref) + `resolvedChartKey` (effective) + provenance.
  `resolveChart(userKey, adminDefault, availableKeys)`: userKey if in availableKeys → source
  "user"; else adminDefault (if set) → "common/admin"; else null → "code". (Tokens are NOT in
  getMe — the frontend maps key→tokens via the registry.)

RBAC: NEW `PERMISSIONS.CHARTS_MANAGE = "charts.manage"` (admin-only, NOT grantable). Chart
SELECTION reads/writes are owner-scoped on `chats.read` (every approved user).

## 5. Frontend

- `src/lib/useChart.ts` — `useApplyChart(chartKey: string|null, effectiveMode: "light"|"dark")`:
  resolve key→tokens via the registry (null/unknown → clear all). For each COLOR_TOKEN:
  `setProperty('--'+token, tokens.colors[effectiveMode][token])` or `removeProperty`. radius +
  fonts (mode-independent) set once. **Reapply on (chartKey × effectiveMode) change.** Apply
  via `setProperty` ONLY — never build a `<style>` string (same path P4 will harden). Mirror
  the theme's localStorage anti-flash cache if cheap (optional, non-blocking). `effectiveMode`
  comes from the resolved theme (system→matchMedia), coordinated with `useApplyTheme`.
  Wire it next to `useApplyTheme` in router.tsx (RoleGate), fed by `me.resolvedChartKey`.
- **Apparence tab refonte** (`ThemeShowroom.tsx`):
  - Tab `theme` permission `chats.read` (was `admin.manage`) → visible to all; the admin
    section is gated INSIDE the component on `me.role==="admin"` (server also gates each admin
    mutation). The default theme-mode + default-language admin controls MOVE into that gated
    admin section (they were the whole panel before).
  - User section (ALL): "Ma charte graphique" — a picker (cards/swatches with a small live
    preview) over `listMyCharts` + a "Défaut de l'app" entry (null). Selecting calls
    `setMyChart`. Reflects the resolved selection.
  - Admin section (CHARTS_MANAGE): global default chart (`setDefaultChart`); per-builtin
    availability — common vs restricted-to-groups (assign/removeChartToGroup, multi-select of
    groups). Plus the existing default theme-mode/language controls.
- All strings i18n (`m.charts_*` / reuse `m.appearance_*`) in BOTH fr.json + en.json.

## 6. Tests

`convex/charts.test.ts`:
- listMyCharts: a common builtin is offered to everyone; a restricted builtin is offered ONLY
  to members of its groups (non-member does NOT see it).
- setMyChart REJECTS a key not available to the user; accepts an available key + null.
- assign/removeChartToGroup dedup; deleteGroup cascade purges groupCharts.
- resolveChart precedence (user pick > admin default > null) incl. "user pick no longer
  available → falls back to default".
- CHARTS_MANAGE gates admin mutations (real identity); listMyCharts is owner-scoped/effective.
- registry cohesion (if duplicated): backend keys == frontend keys.
Frontend: a small unit on the token→setProperty mapping if practical (the real proof is live).

## 7. ACCEPTANCE = LIVE (the load-bearing test)

Selecting a chart changes the on-screen colors in **light AND dark**, radius changes, font
changes; selecting "Défaut" restores the native look; a restricted chart is invisible to a
non-member; non-admin sees the picker but NOT the admin section. Chrome-devtools verified by
the lead before declaring P3 done.

## Gate (green before P3 declared done)
`npx convex codegen` · `tsc --noEmit` 0 · i18n parity · ratchet ≤ baseline · `vitest run` all ·
`npm run build` 0 · **NUL-byte scan clean** · lead diff-review (RBAC, cascade, no scope-creep
into P4) · live verification.
