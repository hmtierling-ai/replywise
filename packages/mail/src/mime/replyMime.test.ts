import { describe, expect, it } from "vitest";
import { buildReplyMime, toBase64Url } from "./replyMime";

const input = {
  from: { name: "Me", address: "me@gmail.com" },
  to: { name: "Ada Lovelace", address: "ada@client.com" },
  subject: "Contract",
  inReplyTo: "<m1@client.com>",
  references: ["<m0@client.com>", "<m1@client.com>"],
  body: "Hi Ada,\n\nYes.\n\n— Me",
};

describe("buildReplyMime", () => {
  it("builds a plain-text reply with threading headers and CRLF line endings", () => {
    const mime = buildReplyMime(input);
    expect(mime).toContain("From: Me <me@gmail.com>\r\n");
    expect(mime).toContain("To: Ada Lovelace <ada@client.com>\r\n");
    expect(mime).toContain("Subject: Re: Contract\r\n");
    expect(mime).toContain("In-Reply-To: <m1@client.com>\r\n");
    expect(mime).toContain("References: <m0@client.com> <m1@client.com>\r\n");
    expect(mime).toContain("Content-Type: text/plain; charset=UTF-8\r\n");
    expect(mime).toContain("Content-Transfer-Encoding: base64\r\n");
    const body = mime.split("\r\n\r\n")[1] ?? "";
    expect(Buffer.from(body.replace(/\r\n/g, ""), "base64").toString("utf8")).toBe(
      "Hi Ada,\r\n\r\nYes.\r\n\r\n— Me",
    );
  });
  it("does not double the Re: prefix and encodes non-ASCII headers", () => {
    const mime = buildReplyMime({
      ...input,
      subject: "RE: Contrato de prestação",
      to: { name: "José", address: "jose@x.com" },
    });
    expect(mime).toContain("Subject: =?UTF-8?B?");
    expect(mime).not.toMatch(/Subject: Re: RE:/);
    expect(mime).toContain("To: =?UTF-8?B?");
  });
  it("strips CR/LF from header values (header injection)", () => {
    const mime = buildReplyMime({
      ...input,
      subject: "Hi\r\nBcc: evil@x.com",
      to: { name: "A\nBcc: e@x", address: "ada@client.com" },
    });
    expect(mime).not.toMatch(/^Bcc:/m);
  });
  it("omits threading headers when there is no Message-ID to reply to", () => {
    const mime = buildReplyMime({ ...input, inReplyTo: null, references: [] });
    expect(mime).not.toContain("In-Reply-To");
    expect(mime).not.toContain("References");
  });
});

describe("toBase64Url", () => {
  it("is URL-safe without padding", () => {
    expect(toBase64Url("??>")).toBe(Buffer.from("??>").toString("base64url"));
    expect(toBase64Url("a")).not.toContain("=");
  });
});
