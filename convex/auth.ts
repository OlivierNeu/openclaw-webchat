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
import {
  allowedEmailDomains,
  emailDomainAllowed,
  emailVerifiedTruthy,
} from "./lib/authDomains";

// Email-domain restriction: sign-in is allowed ONLY for Google accounts whose
// VERIFIED email is in an allowed domain (lib/authDomains; default lacneu.com /
// ataraxis-coaching.com, overridable via AUTH_ALLOWED_EMAIL_DOMAINS). This
// provider profile() is the first gate (rejects in the OAuth flow); the
// AUTHORITATIVE gate is in lib/access.ensureProfile (convex-testable +
// defense-in-depth). Log the resolved allowlist once at load so a typo'd env
// (which silently falls back to the defaults) is visible in deployment logs.
console.log(`[auth] allowed email domains: ${allowedEmailDomains().join(", ")}`);

// Google is the production sign-in (needs AUTH_GOOGLE_ID/SECRET + OAuth redirect,
// not available on a local anonymous deployment). Anonymous is a DEV-ONLY method
// so the chat can be exercised locally without OAuth creds: it mints a real
// `users` row + session, so ctx.auth/getAuthUserId work end-to-end. Gate it to
// dev so it never ships as a sign-in path in production. NOTE: Anonymous has NO
// email → it BYPASSES the domain gate by design (dev-only; must stay off in prod).
const isDev = process.env.OPENCLAW_ENABLE_ANON_AUTH === "1";

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [
    Google({
      // Reads AUTH_GOOGLE_ID / AUTH_GOOGLE_SECRET from deployment env.
      // Server-side gate: only a Google-VERIFIED email in an allowed domain may
      // sign in. Throwing here aborts the OAuth sign-in.
      profile(p: Record<string, unknown>) {
        if (!emailVerifiedTruthy(p.email_verified)) {
          throw new Error("Email non vérifié par Google.");
        }
        const email = p.email as string | undefined;
        if (!emailDomainAllowed(email)) {
          throw new Error("Domaine de courriel non autorisé.");
        }
        return {
          id: p.sub as string,
          name: (p.name as string | undefined) ?? null,
          email: email ?? null,
          image: (p.picture as string | undefined) ?? null,
        };
      },
    }),
    ...(isDev ? [Anonymous()] : []),
  ],
});
