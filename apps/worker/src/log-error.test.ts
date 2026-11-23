import { AiRateLimitedError } from "@replywise/ai";
import { OAuthError, ProviderHttpError } from "@replywise/mail";
import { describe, expect, it } from "vitest";
import { safeErrorFields, sanitizeError } from "./log-error";

class FakeDrizzleQueryError extends Error {
  constructor(cause: unknown) {
    super(
      'Failed query: insert into "messages" ("subject", "snippet") values ($1, $2)\nparams: secret subject,ada@x.com',
      { cause },
    );
    this.name = "DrizzleQueryError";
  }
}

describe("safeErrorFields", () => {
  it("keeps only the name and SQLSTATE of a query error, never its message or stack", () => {
    const fields = safeErrorFields(
      new FakeDrizzleQueryError(
        Object.assign(new Error("duplicate key secret subject"), { code: "23505" }),
      ),
    );
    expect(fields).toEqual({ name: "DrizzleQueryError", code: "23505" });
    const serialized = JSON.stringify(fields);
    expect(serialized).not.toContain("secret subject");
    expect(serialized).not.toContain("ada@x.com");
  });

  it("returns only the name for other unknown errors", () => {
    expect(safeErrorFields(new Error("secret subject"))).toEqual({ name: "Error" });
    expect(safeErrorFields(new FakeDrizzleQueryError({ code: 42 }))).toEqual({
      name: "DrizzleQueryError",
    });
    expect(safeErrorFields("secret subject")).toEqual({ name: "string" });
  });

  it("keeps the fixed messages of provider and OAuth errors", () => {
    expect(safeErrorFields(new ProviderHttpError(500, "/gmail/v1/users/me/threads"))).toEqual({
      name: "ProviderHttpError",
      message: "Provider request failed (500) at /gmail/v1/users/me/threads",
    });
    expect(safeErrorFields(new OAuthError("invalid_grant", 400, "secret description"))).toEqual({
      name: "OAuthError",
      message: "invalid_grant",
    });
  });
});

describe("safeErrorFields (AI)", () => {
  it("keeps the fixed message of AI errors", () => {
    expect(safeErrorFields(new AiRateLimitedError())).toEqual({
      name: "AiRateLimitedError",
      message: "AI provider rate limit reached",
    });
  });
});

describe("sanitizeError", () => {
  it("replaces a query error with one carrying only its name and SQLSTATE", () => {
    const safe = sanitizeError(
      new FakeDrizzleQueryError(Object.assign(new Error("secret subject"), { code: "40P01" })),
    );
    expect(safe.name).toBe("DrizzleQueryError");
    expect(safe.message).toBe("DrizzleQueryError (40P01)");
    expect(`${safe.message}\n${safe.stack}`).not.toContain("secret subject");
    expect(`${safe.message}\n${safe.stack}`).not.toContain("ada@x.com");
  });

  it("passes provider and OAuth errors through unchanged", () => {
    const provider = new ProviderHttpError(403, "/gmail/v1/users/me/profile");
    const oauth = new OAuthError("invalid_grant", 400);
    expect(sanitizeError(provider)).toBe(provider);
    expect(sanitizeError(oauth)).toBe(oauth);
  });
});
