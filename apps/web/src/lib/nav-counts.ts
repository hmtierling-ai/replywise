import "server-only";
import { countThreadViews, type ThreadViewCounts } from "@replywise/db";
import { getSession } from "./auth";
import { getDb } from "./db";

/** Nav badge counts for the signed-in user; null when signed out or on any error. */
export async function loadNavCounts(): Promise<ThreadViewCounts | null> {
  try {
    const session = await getSession();
    if (!session) return null;
    return await countThreadViews(getDb(), session.user.id);
  } catch (error) {
    // Fixed message plus the error class only: DB error messages can echo query parameters.
    console.error("nav counts failed", error instanceof Error ? error.name : "unknown");
    return null;
  }
}
