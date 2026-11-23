/** Ordered by precedence: a thread's primary bucket is the first one that applies. */
export const INBOX_CATEGORIES = [
  "urgent",
  "important",
  "needs_reply",
  "informational",
  "low_priority",
] as const;

export type InboxCategory = (typeof INBOX_CATEGORIES)[number];

export interface CategoryMeta {
  label: string;
  slug: string;
  description: string;
}

export const CATEGORY_META: Readonly<Record<InboxCategory, CategoryMeta>> = {
  urgent: {
    label: "Urgent",
    slug: "urgent",
    description: "Time-sensitive and needs your attention now.",
  },
  important: {
    label: "Important",
    slug: "important",
    description: "Matters to you, but nothing is on fire.",
  },
  needs_reply: {
    label: "Needs Reply",
    slug: "needs-reply",
    description: "Someone is waiting on your answer.",
  },
  informational: {
    label: "Informational",
    slug: "informational",
    description: "Worth knowing, no action needed.",
  },
  low_priority: {
    label: "Low Priority",
    slug: "low-priority",
    description: "Newsletters, notifications and noise.",
  },
};

export function categoryFromSlug(slug: string): InboxCategory | null {
  return INBOX_CATEGORIES.find((category) => CATEGORY_META[category].slug === slug) ?? null;
}

export interface InsightScores {
  /** 1–5 */
  urgency: number;
  /** 1–5 */
  importance: number;
  needsReply: boolean;
}

/**
 * Primary bucket by precedence (spec §4): Urgent > Important > Needs Reply > Informational >
 * Low Priority. Thresholds are deliberately simple so they can be tuned without re-running AI.
 */
export function deriveCategory(scores: InsightScores): InboxCategory {
  if (scores.urgency >= 4) return "urgent";
  if (scores.importance >= 4) return "important";
  if (scores.needsReply) return "needs_reply";
  if (scores.importance >= 2) return "informational";
  return "low_priority";
}
