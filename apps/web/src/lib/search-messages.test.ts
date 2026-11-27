import { describe, expect, it } from "vitest";
import { GMAIL_SEARCH_ERRORS, gmailSearchErrorCode } from "./search-messages";

describe("gmailSearchErrorCode", () => {
  it("maps reauth and rate limits, and everything else to gmail_error", () => {
    const reauth = Object.assign(new Error("Mailbox x must be reconnected"), {
      name: "ReauthRequiredError",
    });
    const limited = Object.assign(new Error("Provider request failed (429)"), {
      name: "ProviderHttpError",
      rateLimited: true,
    });
    const failed = Object.assign(new Error("Provider request failed (500)"), {
      name: "ProviderHttpError",
      rateLimited: false,
    });
    expect(gmailSearchErrorCode(reauth)).toBe("needs_reauth");
    expect(gmailSearchErrorCode(limited)).toBe("rate_limited");
    expect(gmailSearchErrorCode(failed)).toBe("gmail_error");
    expect(gmailSearchErrorCode("boom")).toBe("gmail_error");
  });

  it("has copy for every code", () => {
    for (const code of ["invalid_query", "needs_reauth", "rate_limited", "gmail_error"] as const) {
      expect(GMAIL_SEARCH_ERRORS[code]).toBeTruthy();
    }
  });
});
