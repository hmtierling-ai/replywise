import type { EmailAddress } from "@replywise/core";

export function formatParticipants(participants: EmailAddress[], ownEmails: string[]): string {
  if (participants.length === 0) return "(no sender)";
  const own = new Set(ownEmails.map((e) => e.toLowerCase()));
  const others = participants.filter((p) => !own.has(p.address.toLowerCase()));
  if (others.length === 0) return "me";
  const names = others.map((p) => p.name ?? p.address);
  const shown = names.slice(0, 2).join(", ");
  return names.length > 2 ? `${shown} +${names.length - 2}` : shown;
}

export function formatThreadTime(date: Date, now: Date, timeZone?: string): string {
  const day = (d: Date) => d.toLocaleDateString("en-CA", { timeZone });
  if (day(date) === day(now)) {
    return date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone });
  }
  const sameYear =
    date.toLocaleDateString("en-US", { year: "numeric", timeZone }) ===
    now.toLocaleDateString("en-US", { year: "numeric", timeZone });
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
    timeZone,
  });
}

export function formatSyncStatus(
  account: {
    status: "active" | "needs_reauth" | "error";
    lastSyncedAt: Date | null;
    lastError: string | null;
  },
  now: Date,
): string {
  if (account.status === "needs_reauth") return "Paused until you reconnect";
  if (account.lastError) return `Last sync failed: ${account.lastError}`;
  if (!account.lastSyncedAt) return "Syncing your inbox…";
  const minutes = Math.floor((now.getTime() - account.lastSyncedAt.getTime()) / 60_000);
  if (minutes < 1) return "Synced just now";
  if (minutes < 60) return `Synced ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `Synced ${hours} h ago` : `Synced ${Math.floor(hours / 24)} d ago`;
}
