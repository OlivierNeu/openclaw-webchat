# P5 — Spec technique (CONTRAT) — Introspection « qui a accès à quoi »

> P5 = a READ-ONLY admin screen: pick a user → see their groups, available agents (with
> provenance), available charts (with provenance), and effective permissions. The
> provenance already exists from P2–P4 (`via`); P5 aggregates + renders it. **NO mutations.**

## Threat model (the one real surface)
The aggregation query exposes ANOTHER user's access map → it MUST gate on **admin** (real
identity, impersonation does not grant it). This is the inverse-IDOR: a non-admin must never
introspect anyone (including themselves through this endpoint — they have their own owner-scoped
queries). Gate = `requirePermission(ctx, PERMISSIONS.ADMIN_MANAGE)` on the REAL identity.

## Backend — `convex/introspect.ts` (NEW), one query
`introspectUser({ userId })` (gate `admin.manage`, REAL identity):
- `user`: `{ userId, label }` (non-PHI label, same idiom as audit/groups `userLabel`).
- `role` + `permissions`: the EFFECTIVE permissions of `userId` (reuse
  `effectiveUserPermissions(userId)` from lib/access; expand the wildcard for an admin target).
- `groups`: the user's memberships — reuse the membership read (groupMembers by_user) →
  `[{ groupId, key, name }]`.
- `agents`: reuse `enrichUserAgents(ctx, userId)` → `[{ instanceName, agentId, displayName,
  via: "user" | { group }, isDefault, state }]` (provenance already there).
- `charts`: reuse `availableChartsForUser(ctx, userId)` → `[{ key, name, via: "common" |
  { group } | "owner" }]`.
REUSE the existing helpers with the ARBITRARY `userId` argument (they already take a userId);
the admin gate is the boundary. Bounded reads. NO new mutation, NO write.
Also a small `listUsersForIntrospect()` OR reuse `admin.listUsers` for the picker (admin-gated).

## Frontend — new admin tab "Accès"
- `src/chat/admin/AccessTab.tsx` (NEW): a user picker (reuse `admin.listUsers`) → on select,
  query `introspectUser({ userId })` and render 4 sections with PROVENANCE badges:
  - Groupes (the user's group memberships).
  - Agents disponibles — each with a badge "direct" (via=user) | "groupe : <name>" (via=group),
    its state (ok/deleted/stale), and the default marker.
  - Chartes disponibles — each with a badge "commune" | "groupe : <name>" | "perso" (via).
  - Permissions effectives (the resolved permission keys; admin → wildcard noted).
- Wire it: `AdminSettings.tsx` (TABS + PARAMLESS_TABS + `TAB_PERMISSION.access = "admin.manage"`
  + `TAB_LABELS.access = "Accès"`); `SettingsNav.tsx` (`TAB_I18N.access = () => m.settings_tab_access()`);
  `router.tsx` (`case "access": return <AccessTab />`).
- All strings i18n `m.access_*` / `m.settings_tab_access` in BOTH locales. English/ASCII comments.

## Tests — `convex/introspect.test.ts`
- `introspectUser` gate: a real NON-admin is rejected; an admin impersonating a user is STILL
  allowed (gate = real identity).
- Aggregation: a user who is a MEMBER of a group holding an agent + a chart shows BOTH with
  `via: {group}`; a direct agent shows `via:"user"`; an owned chart shows `via:"owner"`; a
  common chart `via:"common"`. Effective permissions match the user's role + extraPermissions.
- A user with no groups/agents/charts → empty sections (not an error).

## Gate
codegen · tsc 0 · parity · ratchet ≤ baseline · vitest all · build 0 · **NUL scan** · lead
diff-review (admin gate on the aggregation query — the only real surface) · live verify (admin
picks a user → sees provenance; non-admin cannot reach the tab).
