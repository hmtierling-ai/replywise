import { describe, expect, it } from "vitest";
import { createLogger } from "./logger";

function capture() {
  const lines: string[] = [];
  return {
    stream: { write: (chunk: string) => void lines.push(chunk) },
    records: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
    raw: () => lines.join(""),
  };
}

describe("createLogger", () => {
  it("redacts secrets at the top level and one level deep", () => {
    const out = capture();
    const logger = createLogger({ name: "test" }, out.stream);
    logger.info(
      {
        apiKey: "sk-ant-top-level",
        credential: { apiKey: "sk-ant-nested", accessToken: "ya29.token", refreshToken: "1//r" },
        headers: { authorization: "Bearer abc", cookie: "session=xyz" },
      },
      "saving credential",
    );
    const raw = out.raw();
    for (const secret of [
      "sk-ant-top-level",
      "sk-ant-nested",
      "ya29.token",
      "1//r",
      "Bearer abc",
      "session=xyz",
    ]) {
      expect(raw).not.toContain(secret);
    }
    expect(raw).toContain("[Redacted]");
  });

  it("redacts email content fields", () => {
    const out = capture();
    createLogger({ name: "test" }, out.stream).info(
      { message: { bodyText: "Dear Bob, my SSN is 123", bodyHtml: "<p>secret</p>" }, body: "raw" },
      "synced",
    );
    expect(out.raw()).not.toContain("SSN");
    expect(out.raw()).not.toContain("<p>secret</p>");
  });

  it("keeps non-sensitive fields and tags records with the service name", () => {
    const out = capture();
    createLogger({ name: "worker" }, out.stream).info({ mailAccountId: "abc", purged: 3 }, "done");
    expect(out.records()[0]).toMatchObject({
      service: "worker",
      mailAccountId: "abc",
      purged: 3,
      msg: "done",
    });
  });

  it("respects the log level", () => {
    const out = capture();
    const logger = createLogger({ name: "test", level: "warn" }, out.stream);
    logger.info("hidden");
    logger.warn("shown");
    expect(out.records().map((r) => r.msg)).toEqual(["shown"]);
  });
});
