import { categoryFromSlug } from "@replywise/core";

export type RouteDecision =
  | { type: "next" }
  | { type: "redirect"; to: string }
  | { type: "notFound" };

const AUTH_PAGES = new Set(["/sign-in", "/sign-up"]);
const CATEGORY_PATH = /^\/inbox\/([^/]+)\/?$/;

/**
 * Optimistic routing based only on whether a session cookie exists.
 * It is not an authorization check: data access must still verify the session (DAL).
 */
export function routeDecision(pathname: string, hasSessionCookie: boolean): RouteDecision {
  // Never redirect away from auth pages on cookie presence alone: a stale cookie would loop
  // /inbox -> /sign-in -> /inbox. The pages check the real session (RedirectIfSignedIn).
  if (AUTH_PAGES.has(pathname)) return { type: "next" };
  if (!hasSessionCookie) return { type: "redirect", to: "/sign-in" };

  const category = CATEGORY_PATH.exec(pathname)?.[1];
  if (category !== undefined && categoryFromSlug(category) === null) return { type: "notFound" };

  return { type: "next" };
}
