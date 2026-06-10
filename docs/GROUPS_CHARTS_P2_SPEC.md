# P2 — Spec technique (CONTRAT d'implémentation)

> Contrat figé contre lequel les implémenteurs codent ET les adversaires challengent.
> Périmètre STRICT P2. **Interdit en P2** : toute table/fonction `charts`/`groupCharts`
> (c'est P3). Tout scope-creep charte = rejet en red team.

## Périmètre P2

Réintroduire les GROUPES (regrouper des users) + partage d'AGENTS par groupe, avec
RBAC admin, cascades, et résolveurs introspectables. Rien d'autre.

## 1. Schéma (`convex/schema.ts`) — 3 nouvelles tables

```ts
groups: defineTable({
  key: v.string(),                 // stable slug, unique (generated from name)
  name: v.string(),
  description: v.optional(v.string()),
  createdBy: v.id("users"),
  createdAt: v.number(),
}).index("by_key", ["key"]),

groupMembers: defineTable({
  groupId: v.id("groups"),
  userId: v.id("users"),
  joinedAt: v.number(),
})
  .index("by_group", ["groupId"])
  .index("by_user", ["userId"])
  .index("by_user_group", ["userId", "groupId"]),   // membership check + dedup

groupAgents: defineTable({
  groupId: v.id("groups"),
  instanceName: v.string(),
  agentId: v.string(),
  isDefault: v.optional(v.boolean()),                // per-group default (optional)
  createdAt: v.number(),
})
  .index("by_group", ["groupId"])
  .index("by_instance", ["instanceName"])            // cascade on deleteInstance
  .index("by_group_instance_agent", ["groupId", "instanceName", "agentId"]), // dedup
```

## 2. RBAC (`convex/lib/rbac.ts`)

- Add `PERMISSIONS.GROUPS_MANAGE = "groups.manage"`.
- Admin holds `["*"]` → already includes it. **Admin-only: do NOT add to
  `GRANTABLE_USER_PERMISSIONS`.** No new builtin role.

## 3. Backend `convex/groups.ts` (NEW)

All mutations gate on `requirePermission(ctx, PERMISSIONS.GROUPS_MANAGE)` (REAL
identity — admin) and `auditImpersonated`. Queries split: admin management queries
gate on `groups.manage`; `listMyGroups` is owner-scoped on the EFFECTIVE user.

Mutations:
- `createGroup({ name, description? })` → unique `key` slug from name (collision-safe
  suffix), insert, audit → returns `groupId`.
- `updateGroup({ groupId, name?, description? })` → patch (do NOT change key).
- `deleteGroup({ groupId })` → CASCADE: delete all `groupMembers` (by_group) +
  all `groupAgents` (by_group), THEN the group. Audit. Bounded reads.
- `addMember({ groupId, userId })` → dedup via `by_user_group`; insert; audit.
- `removeMember({ groupId, userId })` → delete row; audit. Idempotent.
- `assignAgentToGroup({ groupId, instanceName, agentId })` → REJECT unless the agent
  is `source === "discovered"` AND `presentInLastOk === true` (mirror `assignAgent`);
  dedup via `by_group_instance_agent`; insert; audit.
- `removeAgentFromGroup({ groupId, instanceName, agentId })` → delete; audit.

Queries:
- `listGroups()` (groups.manage) → `[{ _id, key, name, description?, memberCount,
  agentCount, createdAt }]`.
- `getGroup({ groupId })` (groups.manage) → `{ group, members: [{userId, label}],
  agents: [{instanceName, agentId, displayName?, isDefault, state}] }`.
- `listMyGroups()` (effective user via `requireUserId`) → `[{ groupId, key, name }]`
  for the EFFECTIVE user's memberships. Used by the agents union + introspection.

## 4. `convex/agents.ts` — union-au-read (THE sensitive edit)

Extend `enrichUserAgents(userId)`:
- Read direct `userAgents` (unchanged).
- Read the user's groups (`groupMembers` by_user) → their `groupAgents` (by_group).
- UNION by `(instanceName, agentId)`, dedup. **Direct membership WINS** over group
  on dedup. Each enriched agent gains provenance: `via: "user" | { group: key }`.
- **Default precedence (EFFECTIVE default):** direct `userAgents.isDefault`
  > group `groupAgents.isDefault` (deterministic order: lowest groupId/agentId)
  > instance native default > code. The existing invariant "exactly one isDefault
  per user" applies to DIRECT `userAgents` ONLY — unchanged. Group agents do NOT
  write `userAgents` rows (no materialization).
- Agent-deleted handling (presentInLastOk=false → state deleted/stale/unknown) is
  applied to the WHOLE unioned set, identically to today.

**HARD INVARIANT (regression guard):** with NO groups / NO groupAgents, the output
of `enrichUserAgents`, `listMyAgents`, and `resolveTargetForChat` is BYTE-FOR-BYTE
the same as before P2. A dedicated test pins this.

- `resolveTargetForChat` (`convex/routing.ts`): consumes the effective set; default
  target follows the precedence above; re-bind on deleted agent unchanged.
- New admin assign/remove agent-to-group mutations live in `groups.ts` (§3), not here.

## 5. Cascades

- `admin.deleteInstance` → ALSO purge `groupAgents` by_instance (in addition to
  `userAgents`). Same bounded-read pattern.
- User deletion path (locate the existing cascade) → ALSO purge `groupMembers`
  by_user. (Personal charts = P3.)

## 6. Introspection foundation

Resolvers return provenance, not bare values. `enrichUserAgents` items carry `via`.
`listMyGroups` exposes membership. P5's "who has what" screen is a pure render of
these — do NOT build the inspector UI in P2 (only the data shape).

## 7. Frontend — admin "Groupes" tab

- `src/chat/admin/GroupsTab.tsx` (NEW): list groups (name, #members, #agents);
  create (dialog), rename, delete (confirm guard); manage members (add/remove from
  the user list); associate/remove agents (from discovered agents). All strings i18n
  (`m.groups_*` / `m.settings_tab_groups`), FR + EN.
- `AdminSettings.tsx`: add `"groups"` to `TABS` + `PARAMLESS_TABS`;
  `TAB_PERMISSION.groups = "groups.manage"`; `TAB_LABELS.groups = "Groupes"`.
- `SettingsNav.tsx`: `TAB_I18N.groups = () => m.settings_tab_groups()`.
- `router.tsx`: `case "groups": return <GroupsTab />` in `SettingsParamlessScreen`.

## 8. Tests (`convex/groups.test.ts` + agents union additions)

- createGroup → listGroups; updateGroup; deleteGroup CASCADE (members + agents gone).
- addMember/removeMember + dedup (no double row).
- assignAgentToGroup REJECTS a non-discovered / not-present agent; dedup.
- UNION read: user member of a group holding agent X (not direct) → `listMyAgents`
  includes X with `via: {group}`.
- PRECEDENCE: user has direct default A + group default B → effective default = A.
- **REGRESSION: user with NO group → `enrichUserAgents` output identical to pre-P2**
  (same agents, same default, same states).
- RBAC: `groups.manage` required (non-admin rejected); REAL identity (gate = real
  admin; impersonation neither grants nor removes it — a real admin acting while
  impersonating STILL manages groups, and the action is attributed via
  `auditImpersonated`; a real non-admin is rejected).
- `deleteInstance` purges `groupAgents`.

## Gate (must be green before P2 is declared done)

`npx convex codegen` (types) · `tsc --noEmit` 0 · i18n parity · ratchet ≤ baseline
(new UI strings via `m.*`, comments in English) · `vitest run` all green · `npm run build` 0.
