import { ProviderHttpError } from "@replywise/mail";
import { describe, expect, it } from "vitest";
import { describeSyncError } from "./errors";

describe("describeSyncError", () => {
  it("describes rate limits with a fixed string", () => {
    expect(describeSyncError(new ProviderHttpError(403, "/x", true))).toBe(
      "Gmail rate limit reached; will retry on the next sync",
    );
  });

  it("keeps the generic status text for other provider errors", () => {
    expect(describeSyncError(new ProviderHttpError(403, "/x"))).toBe(
      "Gmail API request failed (403)",
    );
  });
});
