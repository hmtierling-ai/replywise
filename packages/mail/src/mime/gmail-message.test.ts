import { describe, expect, it } from "vitest";
import {
  type GmailMessagePart,
  type GmailMessageResource,
  parseGmailMessage,
} from "./gmail-message";

const b64 = (s: string, encoding: BufferEncoding = "utf8") =>
  Buffer.from(s, encoding).toString("base64url");

function message(overrides: Partial<GmailMessageResource> = {}): GmailMessageResource {
  return {
    id: "msg-1",
    threadId: "thread-1",
    labelIds: ["INBOX", "UNREAD"],
    snippet: "Can we meet &amp; talk? It&#39;s urgent",
    internalDate: "1763380800000",
    payload: {
      mimeType: "multipart/mixed",
      headers: [
        { name: "From", value: "Ada Lovelace <Ada@Example.com>" },
        { name: "To", value: "me@gmail.com, Bob <bob@x.com>" },
        { name: "Cc", value: "carol@y.com" },
        { name: "Subject", value: "=?UTF-8?Q?Caf=C3=A9_plans?=" },
        { name: "Message-ID", value: "<abc@mail.example.com>" },
      ],
      parts: [
        {
          mimeType: "multipart/alternative",
          parts: [
            {
              mimeType: "text/plain",
              headers: [{ name: "Content-Type", value: 'text/plain; charset="UTF-8"' }],
              body: { data: b64("Hello Ada") },
            },
            {
              mimeType: "text/html",
              headers: [{ name: "Content-Type", value: "text/html; charset=UTF-8" }],
              body: { data: b64("<p>Hello <b>Ada</b></p>") },
            },
          ],
        },
        {
          mimeType: "application/pdf",
          filename: "agenda.pdf",
          body: { attachmentId: "att-1", size: 1024 },
        },
      ],
    },
    ...overrides,
  };
}

describe("parseGmailMessage", () => {
  it("extracts headers, addresses, labels, bodies and attachments", () => {
    const parsed = parseGmailMessage(message());
    expect(parsed).toMatchObject({
      providerMessageId: "msg-1",
      providerThreadId: "thread-1",
      internetMessageId: "<abc@mail.example.com>",
      from: { name: "Ada Lovelace", address: "ada@example.com" },
      to: [
        { name: null, address: "me@gmail.com" },
        { name: "Bob", address: "bob@x.com" },
      ],
      cc: [{ name: null, address: "carol@y.com" }],
      subject: "Café plans",
      snippet: "Can we meet & talk? It's urgent",
      labelIds: ["INBOX", "UNREAD"],
      hasAttachments: true,
      bodyText: "Hello Ada",
      bodyHtml: "<p>Hello <b>Ada</b></p>",
    });
    expect(parsed.sentAt.toISOString()).toBe("2025-11-17T12:00:00.000Z");
  });

  it("decodes non-UTF-8 body charsets", () => {
    const parsed = parseGmailMessage(
      message({
        payload: {
          mimeType: "text/plain",
          headers: [
            { name: "From", value: "a@x.com" },
            { name: "Content-Type", value: "text/plain; charset=ISO-8859-1" },
          ],
          body: { data: b64("Café", "latin1") },
        },
      }),
    );
    expect(parsed.bodyText).toBe("Café");
    expect(parsed.bodyHtml).toBeNull();
    expect(parsed.hasAttachments).toBe(false);
  });

  it("handles single-part HTML messages and missing headers", () => {
    const parsed = parseGmailMessage(
      message({
        labelIds: undefined,
        snippet: undefined,
        payload: { mimeType: "text/html", body: { data: b64("<i>hi</i>") } },
      }),
    );
    expect(parsed).toMatchObject({
      from: { name: null, address: "" },
      to: [],
      subject: "",
      snippet: "",
      labelIds: [],
      bodyText: null,
      bodyHtml: "<i>hi</i>",
      internetMessageId: null,
    });
  });

  it("falls back to the Date header when internalDate is missing", () => {
    const parsed = parseGmailMessage(
      message({
        internalDate: undefined,
        payload: {
          mimeType: "text/plain",
          headers: [{ name: "Date", value: "Mon, 17 Nov 2025 09:30:00 +0000" }],
          body: { data: b64("x") },
        },
      }),
    );
    expect(parsed.sentAt.toISOString()).toBe("2025-11-17T09:30:00.000Z");
  });

  it("caps very large bodies", () => {
    const parsed = parseGmailMessage(
      message({
        payload: { mimeType: "text/plain", body: { data: b64("a".repeat(200_000)) } },
      }),
    );
    expect(parsed.bodyText).toHaveLength(128_000);
  });

  it("strips NUL characters from every returned string", () => {
    const parsed = parseGmailMessage(
      message({
        snippet: "snip\u0000pet",
        payload: {
          mimeType: "text/plain",
          headers: [
            { name: "From", value: "Ad\u0000a <ada\u0000@x.com>" },
            { name: "To", value: "bo\u0000b@x.com" },
            { name: "Subject", value: "Sub\u0000ject" },
            { name: "Message-ID", value: "<a\u0000@x.com>" },
          ],
          body: { data: b64("bo\u0000dy") },
        },
      }),
    );
    const json = JSON.stringify(parsed);
    expect(json).not.toContain("\\u0000");
    expect(parsed.subject).toBe("Subject");
    expect(parsed.snippet).toBe("snippet");
    expect(parsed.bodyText).toBe("body");
  });

  it("does not produce an Invalid Date from an out-of-range internalDate", () => {
    const parsed = parseGmailMessage(
      message({
        internalDate: "1e30",
        payload: { mimeType: "text/plain", body: { data: b64("x") } },
      }),
    );
    expect(parsed.sentAt.getTime()).toBe(0);
  });

  it("uses the Date header when internalDate is invalid", () => {
    const parsed = parseGmailMessage(
      message({
        internalDate: "1e30",
        payload: {
          mimeType: "text/plain",
          headers: [{ name: "Date", value: "Mon, 17 Nov 2025 09:30:00 +0000" }],
          body: { data: b64("x") },
        },
      }),
    );
    expect(parsed.sentAt.toISOString()).toBe("2025-11-17T09:30:00.000Z");
  });

  it("parses payloads nested far deeper than MAX_MIME_DEPTH without throwing", () => {
    let part: GmailMessagePart = { mimeType: "text/plain", body: { data: b64("deep") } };
    for (let i = 0; i < 100; i++) part = { mimeType: "multipart/mixed", parts: [part] };
    expect(() => parseGmailMessage(message({ payload: part }))).not.toThrow();
  });

  it("does not read bodies from inside an attachment part", () => {
    const parsed = parseGmailMessage(
      message({
        payload: {
          mimeType: "multipart/mixed",
          parts: [
            {
              mimeType: "message/rfc822",
              filename: "fwd.eml",
              body: { attachmentId: "att-2", size: 512 },
              parts: [{ mimeType: "text/plain", body: { data: b64("forwarded") } }],
            },
          ],
        },
      }),
    );
    expect(parsed.bodyText).toBeNull();
    expect(parsed.hasAttachments).toBe(true);
  });
});
