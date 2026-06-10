# P4 — Spec technique (CONTRAT) — Import sécurisé de chartes (tokens typés)

> P4 = chartes CUSTOM importées par les users (en plus des builtins P3). The SECURITY
> core is **typed-token validation (allowlist)** + the **cross-user IDOR RBAC** of personal
> charts. **OUT of P4 (deferred):** the CSP (templated from CONVEX_URL at Caddy boot — it
> is UNTESTABLE in the local Vite loop and risks breaking prod WS/storage; ship it as a
> separate deployment hardening step, verified against a real Caddy). `@property` IS in P4.

## 0. Threat model priority (red team must weight in this order)
1. **Cross-user IDOR on personal charts** (a user reading/applying/editing/deleting ANOTHER
   user's chart; associating a chart to a group they are not a member of; promoting their
   chart to common). THIS is the new surface.
2. **Typed-token injection** (exfil `url()`, `@import`, breakout `;}{`, `expression`, unknown
   key, non-allowlisted font) — closed by the allowlist validator.

## 1. Schema — `charts` table (custom only; builtins stay in code)
```ts
charts: defineTable({
  key: v.string(),                         // unique slug
  name: v.string(),
  scope: v.union(v.literal("personal"), v.literal("common")),
  ownerUserId: v.optional(v.id("users")),  // REQUIRED for personal, absent for common
  tokens: <validated ChartTokens object>,  // the SERVER-RE-SERIALIZED tokens (not raw input)
  createdBy: v.id("users"),
  createdAt: v.number(),
}).index("by_key", ["key"]).index("by_owner", ["ownerUserId"]).index("by_scope", ["scope"])
```
`groupCharts.chartKey` (P3) already references a chart key (builtin OR custom). `scope` =
visibility floor; `groupCharts` adds group availability ON TOP (orthogonal), same as P3.

## 2. Typed-token validator (`convex/lib/chartValidation.ts`, server-side, ALLOWLIST)
Closed vocabulary = `COLOR_TOKENS` (from convex/lib/charts.ts) + `radius` + `fontSans` + `fontMono`.
For an imported `{ name, tokens: { colors:{light,dark}, radius?, fontSans?, fontMono? } }`:
- **Unknown key anywhere → REJECT.** Only known tokens allowed.
- **Color** → must match an ANCHORED `^oklch( L C H [/ A] )$` grammar (numeric components only,
  optional alpha, NOTHING after the close paren). **RE-SERIALIZE** from the parsed components and
  store THAT (never the raw user string). Reject hex/rgb/hsl/named (narrowest grammar = the need).
- **radius** → `^[0-9]+(\.[0-9]+)?(rem|px|em)$` (bounded).
- **fontSans/fontMono** → must be a value in a CLOSED `ALLOWED_FONT_STACKS` set (server-defined
  font stacks, e.g. the system sans / a serif / a mono stack). NO free text.
- **Reject any value containing** `;` `{` `}` `(` outside the oklch grammar, `/*`, `url`, `@`,
  `var`, `image-set`, `expression`, `\` or control chars — breakout chars matter AS MUCH as `url()`.
- **Bound sizes**: cap each value length; the closed vocabulary already bounds key count. Cap `name`.
- Validation is a PURE function returning `{ ok, tokens } | { ok:false, error }`, called by the
  import/update mutations. NEVER trust the client; NEVER concat into a `<style>` string.
- Tests: an attack corpus (url/@import/breakout `;}{`/`}html{`/expression/unknown-key/bad-type/
  oversized/non-allowlisted-font) ALL rejected; valid oklch accepted + re-serialized.

## 3. Backend (`convex/charts.ts` extended) — RBAC is the contract
- `importChart({ name, tokens })` (effective user, `chats.read`) → validate; scope="personal",
  ownerUserId = effective user; insert; audit. Returns key.
- `updateChart({ chartId, name?, tokens? })` → **owner OR admin** for personal; **admin ONLY**
  for common. validate tokens.
- `deleteChart({ chartId })` → **owner OR admin** for personal; **admin ONLY** for common.
  CASCADE purge `groupCharts` by_chart. A user whose `profiles.themeName` == this key falls back
  to default (resolveChart already does this — TEST it).
- `assignChartToGroup` / `removeChartFromGroup` (P3, EXTEND the gate): allowed if
  **admin** (any chart, any group) **OR** (effective user OWNS the personal chart AND is a MEMBER
  of the target group). A non-owner / non-member user → REJECT. (This is the user's "associer à
  un ou plusieurs des groupes dont il est membre".)
- `promoteChartToCommon({ chartId })` / scope change → **admin ONLY**. A user CANNOT make their
  chart common.
- `setDefaultChart` (P3) → **REJECT a personal chart** (global default must be common/builtin —
  else an admin pushes a user's personal chart to everyone). [executes the P3 deferred note]
- `listMyCharts` / `listChartsAdmin` / `availableChartKeysForUser` (P3) → EXTEND to include
  custom charts: a personal chart is available to its owner + members of its groups; a common
  chart to everyone; admin sees all.
- `getMe` → return `resolvedChartTokens` (the resolved chart's tokens, builtin from the registry
  OR custom from the DB, resolved server-side atomically) IN ADDITION to `resolvedChartKey`.
- IDOR guards everywhere: `getChart`/apply/update/delete/assign verify ownership/scope against the
  REAL-vs-effective identity split; a user can NEVER reach another user's personal chart by id.

## 4. Frontend
- `useApplyChart(tokens, mode)` — REFACTOR from `(chartKey, mode)`: pass `me.resolvedChartTokens`
  straight to the UNCHANGED `applyChartTokens`. (Builtin resolution moves server-side.) Editing a
  custom chart → getMe re-push → live re-apply. RE-VERIFY live (custom chart, light AND dark).
- `@property` declarations for COLOR_TOKENS + radius + fonts (browser-side typing, defense in
  depth) — must NOT break the native look if a value is unset.
- ThemeShowroom user section: "Importer une charte" (paste JSON in a textarea OR read a small
  `.json` file as TEXT client-side — NO blob upload, NO font-file upload) → importChart; show
  validation errors. List the user's personal charts (edit/delete + associate to THEIR groups).
  Admin section: promote-to-common; manage common charts. All strings i18n FR+EN.

## 5. Cascades / gaps
- delete chart → groupCharts purged + themeName fallback (test).
- delete user → their personal charts (KNOWN GAP: no user-deletion path exists in prod — note it,
  same as P2's groupMembers).

## 6. Tests (RBAC/IDOR FIRST, then validator)
- **IDOR**: user A cannot get/apply/update/delete user B's personal chart (by id); A cannot assign
  B's chart, nor assign to a group A is not a member of; A cannot promote to common; setDefaultChart
  rejects a personal chart. Owner CAN edit/delete own; admin CAN manage common + any personal.
- **Validator**: the attack corpus all-rejected; valid accepted + re-serialized; unknown key rejected.
- **Availability**: personal visible to owner + group members only; common to all; admin all.
- **Cascade**: delete chart → fallback + groupCharts purge.
- All real-vs-effective identity (impersonation): user reads scoped to effective; admin mutations real.

## Gate
codegen · tsc 0 · parity · ratchet ≤ baseline · vitest all · build 0 · **NUL scan** · lead diff-review
(IDOR + validator + no scope-creep) · **live re-verify (custom chart applies light+dark; import a
malicious payload → rejected with a clean error)**.

## Deferred to deployment (NOT P4)
CSP templated from `CONVEX_URL` at Caddy boot (`img-src`/`font-src`/`connect-src` MUST include the
Convex origin or it breaks WS + storage downloads); `frame-ancestors 'none'`; `style-src 'self'`.
Verify against a real Caddy with WS + a storage download working. See [[openclaw-webchat-charts-p3]].
