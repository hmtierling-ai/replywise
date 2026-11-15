import { Suspense } from "react";
import { AccountMenu } from "@/components/app-shell/account-menu";
import { AppShell } from "@/components/app-shell/app-shell";
import { UserMenuSkeleton } from "@/components/app-shell/user-menu";

// proxy.ts gates these routes on the session cookie; AccountMenu verifies the session itself.
// Pages that read user data must call requireUser() (data access layer) — layouts are not a gate.
export default function AppLayout({ children }: LayoutProps<"/">) {
  return (
    <AppShell
      accountSlot={
        <Suspense fallback={<UserMenuSkeleton />}>
          <AccountMenu />
        </Suspense>
      }
    >
      {children}
    </AppShell>
  );
}
