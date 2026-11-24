import { describe, expect, it } from "vitest";
import { buildReplyMime, InvalidRecipientError, toBase64Url } from "./replyMime";

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
    expect(mime).toContain("References: <m0@client.com>\r\n <m1@client.com>\r\n");
    expect(mime).toMatch(/^Date: .+\r\n/m);
    expect(mime).toMatch(/^Message-ID: <[^<>\s]+@gmail\.com>\r\n/m);
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

describe("recipient validation", () => {
  const withTo = (addr: string) => ({ ...input, to: { name: null, address: addr } });
  it.each(["a@x.com, evil@y.com", "a@x.com>evil", "a b@x.com", "a@x.com;b@y.com", "a@@x.com"])(
    "rejects %s",
    (addr) => {
      expect(() => buildReplyMime(withTo(addr))).toThrow(InvalidRecipientError);
    },
  );
  it("rejects an invalid sender and uses a fixed message", () => {
    const bad = { ...input, from: { name: null, address: "me@x.com, evil@y.com" } };
    expect(() => buildReplyMime(bad)).toThrow("Invalid recipient address");
  });
  it("accepts plus addresses", () => {
    expect(buildReplyMime(withTo("ada+tag@client.co.uk"))).toContain(
      "To: ada+tag@client.co.uk\r\n",
    );
  });
});

describe("header folding and quoting", () => {
  it("splits long non-ASCII subjects into words of at most 75 chars", () => {
    const subject = "Prestação 🎉 ".repeat(20).slice(0, 200);
    const mime = buildReplyMime({ ...input, subject });
    const head = mime.split("\r\n\r\n")[0] ?? "";
    for (const line of head.split("\r\n")) expect(line.length).toBeLessThanOrEqual(998);
    const unfolded = head.replace(/\r\n /g, " ");
    const value = /^Subject: (.*)$/m.exec(unfolded)?.[1] ?? "";
    const words = value.split(" ");
    for (const w of words) expect(w.length).toBeLessThanOrEqual(75);
    const decoded = words
      .map((w) => Buffer.from(w.replace(/^=\?UTF-8\?B\?|\?=$/g, ""), "base64").toString("utf8"))
      .join("");
    expect(decoded).toBe(`Re: ${subject}`);
  });
  it("folds many references and appends inReplyTo when missing", () => {
    const refs = Array.from({ length: 40 }, (_, i) => `<r${i}@client.com>`);
    const mime = buildReplyMime({ ...input, references: refs, inReplyTo: "<last@client.com>" });
    const head = mime.split("\r\n\r\n")[0] ?? "";
    expect(head.match(/\r\n <r\d+@client\.com>/g)?.length).toBe(39);
    expect(head).toMatch(/\r\n <last@client\.com>(\r\n|$)/);
  });
  it("escapes backslashes and quotes in quoted display names", () => {
    const mime = buildReplyMime({
      ...input,
      to: { name: 'Ada "A" Smith\\', address: "ada@client.com" },
    });
    expect(mime).toContain('To: "Ada \\"A\\" Smith\\\\" <ada@client.com>\r\n');
  });
  it("drops message ids containing control characters", () => {
    const mime = buildReplyMime({
      ...input,
      references: ["<a\u0000b@x.com>", "<a\u0085b@x.com>", "<ok@x.com>"],
    });
    expect(mime).toContain("References: <ok@x.com>\r\n <m1@client.com>\r\n");
  });
});

describe("toBase64Url", () => {
  it("is URL-safe without padding", () => {
    expect(toBase64Url("??>")).toBe(Buffer.from("??>").toString("base64url"));
    expect(toBase64Url("a")).not.toContain("=");
  });
});
