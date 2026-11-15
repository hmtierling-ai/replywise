import { ThemeSelector } from "@/components/theme-selector";

export const metadata = { title: "Settings" };

export default function SettingsPage() {
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-8 sm:px-6 sm:py-12">
      <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
      <section className="mt-8 flex flex-col gap-4 border-t border-border pt-6 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-sm font-medium">Appearance</h2>
          <p className="text-sm text-muted-foreground">
            Choose light, dark, or follow your system.
          </p>
        </div>
        <ThemeSelector />
      </section>
    </div>
  );
}
