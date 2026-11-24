import type { ClassifyInput, ClassifyMessage } from "./types";

export const CLASSIFY_MAX_MESSAGES = 6;
export const MAX_CHARS_PER_MESSAGE = 4_000;
export const MAX_TOTAL_CHARS = 16_000;

const TRUNCATION_MARK = "\n[truncated]";

/** Attribute values: one line, no quotes or angle brackets, bounded length. */
export function attr(value: string): string {
  return value
    .replace(/[\r\n\u0085\u2028\u2029]+/g, " ")
    .replace(/"/g, "'")
    .replace(/</g, "‹")
    .slice(0, 300);
}

/** Stops text from closing or opening our delimiter tags, including with stray whitespace. */
export function neutraliseTags(text: string, tags: string[]): string {
  const names = tags.map((tag) => tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return text.replace(new RegExp(`<\\s*(\\/?)\\s*(${names})\\b`, "gi"), "‹$1$2");
}

/** owner_preferences is neutralised too, so email text cannot forge the owner's block. */
const THREAD_TAGS = ["email_thread", "message", "owner_preferences"];

function render(message: ClassifyMessage, index: number, text: string): string {
  const from = message.from.name
    ? `${message.from.name} <${message.from.address}>`
    : message.from.address;
  const sentAt = Number.isNaN(message.sentAt.getTime()) ? "unknown" : message.sentAt.toISOString();
  return [
    `<message index="${index}" from="${attr(from)}" sent_at="${sentAt}" from_mailbox_owner="${message.isFromUser}" attachments="${message.hasAttachments ? "yes" : "no"}">`,
    neutraliseTags(text, THREAD_TAGS),
    "</message>",
  ].join("\n");
}

/**
 * Deterministic thread block: newest messages win the budget, output is oldest → newest, and all
 * email content sits inside <email_thread> as untrusted data.
 * The budget covers the message text itself, truncation marker included.
 */
export function buildThreadBlock(input: ClassifyInput): string {
  const recent = input.messages.slice(-CLASSIFY_MAX_MESSAGES);
  const blocks: string[] = [];
  let budget = MAX_TOTAL_CHARS;
  for (let i = recent.length - 1; i >= 0 && budget > 0; i--) {
    const message = recent[i];
    if (!message) continue;
    const limit = Math.min(MAX_CHARS_PER_MESSAGE, budget);
    let text = message.text;
    if (text.length > limit) {
      // A budget too small for the marker cannot hold any truncated text, so stop here.
      if (limit < TRUNCATION_MARK.length) break;
      text = `${text.slice(0, limit - TRUNCATION_MARK.length)}${TRUNCATION_MARK}`;
    }
    budget -= text.length;
    blocks.unshift(render(message, i + 1, text));
  }
  return [
    `<email_thread mailbox_owner="${attr(input.mailboxEmail)}" subject="${attr(input.subject)}">`,
    ...blocks,
    "</email_thread>",
  ].join("\n");
}
