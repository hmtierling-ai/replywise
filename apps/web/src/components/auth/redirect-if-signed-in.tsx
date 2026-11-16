import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";

/** Sends visitors with a *valid* session to the inbox. Must render inside <Suspense>. */
export async function RedirectIfSignedIn() {
  if (await getSession()) redirect("/inbox");
  return null;
}
