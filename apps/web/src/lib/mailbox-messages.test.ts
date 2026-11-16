import { describe, expect, it } from "vitest";
import { flashFromSearchParams } from "./mailbox-messages";

describe("flashFromSearchParams", () => {
  it("returns nothing without a known flag", () => {
    expect(flashFromSearchParams({})).toBeNull();
    expect(flashFromSearchParams({ connected: "yahoo" })).toBeNull();
  });

  it("confirms connections and disconnections", () => {
    expect(flashFromSearchParams({ connected: "gmail" })).toEqual({
      tone: "success",
      message:
        "Gmail connected. Replywise can now read your mail and save drafts — it never sends email.",
    });
    expect(flashFromSearchParams({ disconnected: "gmail" })?.tone).toBe("success");
  });

  it("tells Outlook users to remove access themselves", () => {
    const flash = flashFromSearchParams({ disconnected: "outlook", manual: "1" });
    expect(flash?.tone).toBe("info");
    expect(flash?.message).toContain("account.microsoft.com");
  });

  it("explains every connect failure without echoing raw input", () => {
    for (const reason of [
      "not_configured",
      "invalid_state",
      "expired_state",
      "provider_mismatch",
      "access_denied",
      "missing_scopes",
      "provider_error",
    ]) {
      const flash = flashFromSearchParams({ error: reason });
      expect(flash?.tone).toBe("error");
      expect(flash?.message.length).toBeGreaterThan(10);
    }
    const unknown = flashFromSearchParams({ error: "<script>alert(1)</script>" });
    expect(unknown?.message).not.toContain("<script>");
  });

  it("uses the first value when a parameter repeats", () => {
    expect(flashFromSearchParams({ connected: ["outlook", "gmail"] })?.message).toMatch(/^Outlook/);
  });
});
