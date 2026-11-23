import Link from "next/link";
import { ThemeSelector } from "@/components/theme-selector";

export const metadata = { title: "Settings" };

export default function SettingsPage() {
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-8 sm:px-6 sm:py-12">
      <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
      <section className="mt-8 flex flex-col gap-4 border-t border-border pt-6 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-sm font-medium">Mailboxes</h2>
          <p className="text-sm text-muted-foreground">
            Connect, reconnect or remove Gmail and Outlook accounts.
          </p>
        </div>
        <Link
          href="/settings/mailboxes"
          className="text-sm font-medium underline-offset-4 hover:underline"
        >
          Manage mailboxes →
        </Link>
      </section>
      <section className="mt-6 flex flex-col gap-4 border-t border-border pt-6 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-sm font-medium">AI</h2>
          <p className="text-sm text-muted-foreground">
            Your Anthropic API key, classification model and usage.
          </p>
        </div>
        <Link
          href="/settings/ai"
          className="text-sm font-medium underline-offset-4 hover:underline"
        >
          Manage AI →
        </Link>
      </section>
      <section className="mt-6 flex flex-col gap-4 border-t border-border pt-6 sm:flex-row sm:items-center sm:justify-between">
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
