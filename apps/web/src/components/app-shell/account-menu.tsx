import { requireUser } from "@/lib/auth";
import { UserMenu } from "./user-menu";

/** Reads the session; must render inside <Suspense>. Redirects to /sign-in without one. */
export async function AccountMenu() {
  const user = await requireUser();
  return <UserMenu name={user.name} email={user.email} />;
}
