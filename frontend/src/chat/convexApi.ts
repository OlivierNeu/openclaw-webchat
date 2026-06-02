// Single indirection point for the Convex generated API.
//
// `convex dev` / `convex codegen` writes the typed `api` object and `Id` helper
// into `convex/_generated/`. The relative path from this file depends on where
// the `convex/` folder lives in the repo. Adjust ONLY this import if your layout
// differs (e.g. a root-level `convex/` shared by frontend + bridge):
//
//   monorepo root
//   ├── convex/_generated/api      <-- generated here
//   └── frontend/src/chat/convexApi.ts
//
// From `frontend/src/chat/` that root-level folder is `../../../convex/...`.
// If instead `convex/` is nested under `frontend/`, use `../../convex/...`.
//
// Until codegen has run at least once, the import below will not resolve; that
// is expected — it is a *generated* file. Run `npx convex dev` once.

export { api, internal } from "../../../convex/_generated/api";
export type { Id, Doc } from "../../../convex/_generated/dataModel";
