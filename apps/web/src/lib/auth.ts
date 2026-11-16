import "server-only";
import { authAccounts, sessions, users, verifications } from "@replywise/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "./db";
import { getEnv } from "./env";

function createAuth() {
  const env = getEnv();
  const google =
    env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
      ? { google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET } }
      : {};

  return betterAuth({
    baseURL: env.APP_URL,
    secret: env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(getDb(), {
      provider: "pg",
      schema: {
        user: users,
        session: sessions,
        account: authAccounts,
        verification: verifications,
      },
    }),
    emailAndPassword: { enabled: true, minPasswordLength: 12, maxPasswordLength: 128 },
    // Login only: these providers never receive mailbox scopes (spec §5).
    socialProviders: google,
    session: { expiresIn: 60 * 60 * 24 * 14, updateAge: 60 * 60 * 24 },
    rateLimit: { enabled: true, window: 60, max: 30 },
    advanced: { useSecureCookies: env.NODE_ENV === "production" },
    plugins: [nextCookies()],
  });
}

type Auth = ReturnType<typeof createAuth>;
let instance: Auth | undefined;

export function getAuth(): Auth {
  instance ??= createAuth();
  return instance;
}

/** Real (non-optimistic) session lookup; null when the cookie is missing, expired or invalid. */
export async function getSession() {
  // Read request data first: prerendering stops here, so env/DB are never touched at build time.
  const requestHeaders = await headers();
  return getAuth().api.getSession({ headers: requestHeaders });
}

/**
 * Data-access-layer check. Call from any server component, action or handler that reads
 * user data. Under cacheComponents, render callers inside <Suspense>.
 */
export async function requireUser() {
  const session = await getSession();
  if (!session) redirect("/sign-in");
  return session.user;
}
