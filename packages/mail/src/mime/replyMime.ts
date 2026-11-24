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

const clean = (value: string) => value.replace(/[\r\n]+/g, " ").trim();
const isAscii = (value: string) => /^[\x20-\x7e]*$/.test(value);

function encodeWord(value: string): string {
  return isAscii(value) ? value : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function address(a: EmailAddress): string {
  const addr = clean(a.address);
  if (!a.name) return addr;
  const name = clean(a.name).replace(/"/g, "'");
  return isAscii(name)
    ? `${/[(),:;<>@[\]\\.]/.test(name) ? `"${name}"` : name} <${addr}>`
    : `${encodeWord(name)} <${addr}>`;
}

function replySubject(subject: string): string {
  const s = clean(subject);
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}

function messageIds(values: string[]): string[] {
  return values.map(clean).filter((v) => /^<[^<>\s]+>$/.test(v));
}

/** Plain-text reply (RFC 5322, CRLF). Draft only: this module never delivers mail. */
export function buildReplyMime(input: ReplyMimeInput): string {
  const domain = clean(input.from.address).split("@")[1] ?? "replywise.local";
  const headers = [
    `From: ${address(input.from)}`,
    `To: ${address(input.to)}`,
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
    if (refs.length > 0) headers.push(`References: ${refs.join(" ")}`);
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
