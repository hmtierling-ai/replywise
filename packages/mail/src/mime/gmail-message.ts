import type { EmailAddress } from "@replywise/core";
import { parseAddressList } from "./addresses";
import { decodeEncodedWords } from "./encoded-words";
import { decodeHtmlEntities } from "./html-entities";

export const MAX_BODY_HTML_CHARS = 256_000;
export const MAX_BODY_TEXT_CHARS = 128_000;
export const MAX_MIME_DEPTH = 32;

function stripNul(s: string): string {
  return s.replaceAll("\u0000", "");
}

function stripNulAddress(a: EmailAddress): EmailAddress {
  return { name: a.name === null ? null : stripNul(a.name), address: stripNul(a.address) };
}

export interface GmailHeader {
  name: string;
  value: string;
}

export interface GmailMessagePart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailMessagePart[];
}

export interface GmailMessageResource {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GmailMessagePart;
}

export interface ParsedMessage {
  providerMessageId: string;
  providerThreadId: string;
  internetMessageId: string | null;
  from: EmailAddress;
  to: EmailAddress[];
  cc: EmailAddress[];
  subject: string;
  snippet: string;
  sentAt: Date;
  labelIds: string[];
  hasAttachments: boolean;
  bodyText: string | null;
  bodyHtml: string | null;
}

export interface ParsedThread {
  providerThreadId: string;
  messages: ParsedMessage[];
}

function header(headers: GmailHeader[] | undefined, name: string): string | undefined {
  const lower = name.toLowerCase();
  return headers?.find((h) => h.name.toLowerCase() === lower)?.value;
}

function charsetOf(part: GmailMessagePart): string {
  const contentType = header(part.headers, "Content-Type") ?? "";
  const match = /charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType);
  return (match?.[1] ?? "utf-8").toLowerCase();
}

function decodeBody(part: GmailMessagePart): string | null {
  const data = part.body?.data;
  if (!data) return null;
  const bytes = Buffer.from(data, "base64url");
  try {
    return new TextDecoder(charsetOf(part)).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function isAttachment(part: GmailMessagePart): boolean {
  if (part.filename) return true;
  const disposition = header(part.headers, "Content-Disposition") ?? "";
  return /^\s*attachment/i.test(disposition);
}

/** Visits parts depth-first. Attachments are reported but their children are not descended into. */
function walk(part: GmailMessagePart, visit: (p: GmailMessagePart) => boolean, depth = 0): void {
  if (depth > MAX_MIME_DEPTH) return;
  if (!visit(part)) return;
  for (const child of part.parts ?? []) walk(child, visit, depth + 1);
}

function sentAtOf(resource: GmailMessageResource, dateHeader: string | undefined): Date {
  const internal = Number(resource.internalDate);
  if (resource.internalDate) {
    const date = new Date(internal);
    if (Number.isFinite(date.getTime())) return date;
  }
  const parsed = dateHeader ? Date.parse(dateHeader) : Number.NaN;
  return Number.isFinite(parsed) ? new Date(parsed) : new Date(0);
}

/** Converts a Gmail `format=full` message into Replywise's provider-neutral shape. */
export function parseGmailMessage(resource: GmailMessageResource): ParsedMessage {
  const payload = resource.payload ?? {};
  const headers = payload.headers;
  let bodyText: string | null = null;
  let bodyHtml: string | null = null;
  let hasAttachments = false;

  walk(payload, (part) => {
    if (isAttachment(part)) {
      hasAttachments = true;
      return false;
    }
    const type = (part.mimeType ?? "").toLowerCase();
    if (type === "text/plain" && bodyText === null) bodyText = decodeBody(part);
    else if (type === "text/html" && bodyHtml === null) bodyHtml = decodeBody(part);
    return true;
  });

  const messageId = header(headers, "Message-ID")?.trim();
  const text = bodyText as string | null;
  const html = bodyHtml as string | null;
  return {
    providerMessageId: stripNul(resource.id),
    providerThreadId: stripNul(resource.threadId),
    internetMessageId: messageId ? stripNul(messageId) : null,
    from: stripNulAddress(
      parseAddressList(header(headers, "From"))[0] ?? { name: null, address: "" },
    ),
    to: parseAddressList(header(headers, "To")).map(stripNulAddress),
    cc: parseAddressList(header(headers, "Cc")).map(stripNulAddress),
    subject: stripNul(decodeEncodedWords(header(headers, "Subject") ?? "").trim()),
    snippet: stripNul(decodeHtmlEntities(resource.snippet ?? "")),
    sentAt: sentAtOf(resource, header(headers, "Date")),
    labelIds: (resource.labelIds ?? []).map(stripNul),
    hasAttachments,
    bodyText: text === null ? null : stripNul(text.slice(0, MAX_BODY_TEXT_CHARS)),
    bodyHtml: html === null ? null : stripNul(html.slice(0, MAX_BODY_HTML_CHARS)),
  };
}
