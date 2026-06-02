// Convex Auth setup (Google sign-in).
//
// This wires @convex-dev/auth with the Google OAuth provider. The exported
// `auth`, `signIn`, `signOut`, `store`, and `isAuthenticated` are consumed by
// `convex/http.ts` (the auth HTTP routes) and by the public functions in this
// project via `getAuthUserId(ctx)`.
//
// SECURITY / DEPLOYMENT:
//   - Google client id/secret are read from deployment env, NOT from source or
//     tables. On a live deployment set them with:
//       npx convex env set AUTH_GOOGLE_ID <client-id>
//       npx convex env set AUTH_GOOGLE_SECRET <client-secret>
//     (@auth/core's Google provider defaults to AUTH_GOOGLE_ID /
//      AUTH_GOOGLE_SECRET.)
//   - REQUIRES A LIVE DEPLOYMENT to actually authenticate; offline this file is
//     just configuration and will not run.
//
// NOTE: @convex-dev/auth also requires an auth-specific schema (authTables) and
// `convex/http.ts` to expose the OAuth callback routes. authTables is spread in
// schema.ts; http.ts registers the routes.

import Google from "@auth/core/providers/google";
import { Anonymous } from "@convex-dev/auth/providers/Anonymous";
import { convexAuth } from "@convex-dev/auth/server";

// Google is the production sign-in (needs AUTH_GOOGLE_ID/SECRET + OAuth redirect,
// not available on a local anonymous deployment). Anonymous is a DEV-ONLY method
// so the chat can be exercised locally without OAuth creds: it mints a real
// `users` row + session, so ctx.auth/getAuthUserId work end-to-end. Gate it to
// dev so it never ships as a sign-in path in production.
const isDev = process.env.OPENCLAW_ENABLE_ANON_AUTH === "1";

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [
    Google({
      // Reads AUTH_GOOGLE_ID / AUTH_GOOGLE_SECRET from deployment env.
      // Placeholders are resolved at runtime on the live deployment.
    }),
    ...(isDev ? [Anonymous()] : []),
  ],
});
