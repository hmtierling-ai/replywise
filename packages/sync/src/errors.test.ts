import { ProviderHttpError } from "@replywise/mail";
import { describe, expect, it } from "vitest";
import { describeSyncError, SyncDeadlineError } from "./errors";

describe("describeSyncError", () => {
  it("describes rate limits with a fixed string", () => {
    expect(describeSyncError(new ProviderHttpError(403, "/x", true))).toBe(
      "Gmail rate limit reached; will retry on the next sync",
    );
  });

  it("describes a passed sync deadline with a fixed string", () => {
    expect(describeSyncError(new SyncDeadlineError())).toBe(
      "Sync is taking longer than expected; will continue on the next sync",
    );
  });

  it("keeps the generic status text for other provider errors", () => {
    expect(describeSyncError(new ProviderHttpError(403, "/x"))).toBe(
      "Gmail API request failed (403)",
    );
  });
});
