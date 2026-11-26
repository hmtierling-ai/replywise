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
  } catch {
    return null;
  }
}
