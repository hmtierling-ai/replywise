import { randomUUID } from "node:crypto";
import type { EmailAddress } from "@replywise/core";

export interface ReplyMimeInput {
  from: EmailAddress;
  to: EmailAddress;
  subject: string;
  /** Message-ID of the message being answered, with angle brackets. */
  inReplyTo: string | null;
  references: string[];
  body: string;
}

/** Thrown when a sender or recipient address could add recipients or break a header. */
export class InvalidRecipientError extends Error {
  constructor() {
    super("Invalid recipient address");
    this.name = "InvalidRecipientError";
  }
}

const FOLD = "\r\n ";
/** Raw UTF-8 bytes per encoded word: 45 bytes -> 60 base64 chars + 12 = 72 <= 75. */
const WORD_BYTES = 45;
/** Longest run of unbreakable ASCII kept on one physical line (limit is 998). */
const MAX_RUN = 900;

const LOCAL_PART = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/;
const DOMAIN = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

const clean = (value: string) => value.replace(/[\r\n]+/g, " ").trim();
const isAscii = (value: string) => /^[\x20-\x7e]*$/.test(value);

function validAddress(value: string): string {
  const parts = value.split("@");
  const [local, domain] = parts;
  if (parts.length !== 2 || !local || !domain) throw new InvalidRecipientError();
  if (!LOCAL_PART.test(local) || !DOMAIN.test(domain)) throw new InvalidRecipientError();
  return value;
}

/** Splits UTF-8 text into chunks of at most `max` bytes without cutting a code point. */
function utf8Chunks(value: string, max: number): Buffer[] {
  const chunks: Buffer[] = [];
  let current = "";
  let size = 0;
  for (const char of value) {
    const bytes = Buffer.byteLength(char, "utf8");
    if (size + bytes > max) {
      chunks.push(Buffer.from(current, "utf8"));
      current = "";
      size = 0;
    }
    current += char;
    size += bytes;
  }
  if (current) chunks.push(Buffer.from(current, "utf8"));
  return chunks;
}

function encodeWord(value: string): string {
  if (isAscii(value)) return foldAscii(value);
  return utf8Chunks(value, WORD_BYTES)
    .map((chunk) => `=?UTF-8?B?${chunk.toString("base64")}?=`)
    .join(FOLD);
}

/** Keeps pathological unbreakable ASCII runs well under the 998 octet line limit. */
function foldAscii(value: string): string {
  return value
    .split(" ")
    .map((token) =>
      token
        .replace(new RegExp(`.{1,${MAX_RUN}}`, "g"), (run) => `${run}${FOLD}`)
        .replace(/\r\n $/, ""),
    )
    .join(" ");
}

function address(a: EmailAddress, addr: string): string {
  if (!a.name) return addr;
  const name = clean(a.name);
  if (!isAscii(name)) return `${encodeWord(name)} <${addr}>`;
  if (/[(),:;<>@[\]\\."]/.test(name)) {
    return `"${name.replace(/[\\"]/g, "\\$&")}" <${addr}>`;
  }
  return `${name} <${addr}>`;
}

function replySubject(subject: string): string {
  const s = clean(subject);
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}

function messageIds(values: string[]): string[] {
  return values.map(clean).filter((v) => /^<[\x21-\x3b\x3d\x3f-\x7e]+>$/.test(v));
}

/** Plain-text reply (RFC 5322, CRLF). Draft only: this module never delivers mail. */
export function buildReplyMime(input: ReplyMimeInput): string {
  const fromAddr = validAddress(clean(input.from.address));
  const toAddr = validAddress(clean(input.to.address));
  const domain = fromAddr.split("@")[1] || "replywise.local";
  const headers = [
    `From: ${address(input.from, fromAddr)}`,
    `To: ${address(input.to, toAddr)}`,
    `Subject: ${encodeWord(replySubject(input.subject))}`,
    `Message-ID: <${randomUUID()}@${domain}>`,
    `Date: ${new Date().toUTCString()}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
  ];
  const inReplyTo = input.inReplyTo ? messageIds([input.inReplyTo])[0] : undefined;
  if (inReplyTo) {
    headers.push(`In-Reply-To: ${inReplyTo}`);
    const refs = messageIds(input.references);
    if (!refs.includes(inReplyTo)) refs.push(inReplyTo);
    headers.push(`References: ${refs.join(FOLD)}`);
  }
  const body = Buffer.from(input.body.replace(/\r?\n/g, "\r\n"), "utf8")
    .toString("base64")
    .replace(/.{1,76}/g, "$&\r\n")
    .trimEnd();
  return `${headers.join("\r\n")}\r\n\r\n${body}`;
}

export function toBase64Url(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}
