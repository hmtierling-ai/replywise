import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Spec §8: Replywise must never send email. Provider code may not reference send endpoints.
const FORBIDDEN = [/sendMail/i, /\/send\b/i, /messages\.send/i, /drafts\/send/i, /mail\.send/i];

describe("no-send guard", () => {
  it("finds no send endpoints or send scopes in provider source", () => {
    const dir = import.meta.dirname;
    const sources = (readdirSync(dir, { recursive: true }) as string[]).filter(
      (file) => file.endsWith(".ts") && !file.endsWith(".test.ts"),
    );
    expect(sources.length).toBeGreaterThan(3);
    const offenders = sources.flatMap((file) => {
      const text = readFileSync(join(dir, file), "utf8");
      return FORBIDDEN.filter((pattern) => pattern.test(text)).map((p) => `${file}: ${p}`);
    });
    expect(offenders).toEqual([]);
  });
});
