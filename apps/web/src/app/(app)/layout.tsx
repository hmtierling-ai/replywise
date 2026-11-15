import { AppShell } from "@/components/app-shell/app-shell";

// Task 9 adds the account menu and session checks (Suspense + per-page DAL + proxy.ts).
export default function AppLayout({ children }: LayoutProps<"/">) {
  return <AppShell>{children}</AppShell>;
}
