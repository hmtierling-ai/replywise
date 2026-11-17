import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Spec §8: Replywise must never send email. Provider code may not reference send endpoints.
const FORBIDDEN = [
  /sendMail/i,
  /\/send\b/i,
  /messages\.send/i,
  /drafts\/send/i,
  /mail\.send/i,
  /drafts\.send/i,
  /\/(reply|replyAll|forward)\b/i,
];

describe("no-send guard", () => {
  it("blocks reply/forward endpoints but allows createReply drafts", () => {
    const reply = FORBIDDEN[FORBIDDEN.length - 1] as RegExp;
    expect(reply.test("/me/messages/x/reply")).toBe(true);
    expect(reply.test("/me/messages/x/createReply")).toBe(false);
  });

  it("finds no send endpoints or send scopes in provider source", () => {
    const dirs = [import.meta.dirname, join(import.meta.dirname, "../../mailbox/src")];
    const sources = dirs.flatMap((dir) =>
      (readdirSync(dir, { recursive: true }) as string[])
        .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
        .map((file) => join(dir, file)),
    );
    expect(sources.length).toBeGreaterThan(10);
    const offenders = sources.flatMap((file) => {
      const text = readFileSync(file, "utf8");
      return FORBIDDEN.filter((pattern) => pattern.test(text)).map((p) => `${file}: ${p}`);
    });
    expect(offenders).toEqual([]);
  });
});
