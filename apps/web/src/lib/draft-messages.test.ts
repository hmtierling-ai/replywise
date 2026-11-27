import { describe, expect, it } from "vitest";
import { GENERATION_ERRORS, generationError, sendActionError, sendFailure } from "./draft-messages";

const WORKER_CODES = [
  "no_ai_key",
  "ai_key_invalid",
  "ai_refused",
  "ai_bad_output",
  "ai_unavailable",
  "gmail_reauth",
  "gmail_unavailable",
  "no_recipient",
  "internal",
];

describe("generationError", () => {
  it("has copy for every code the worker can write", () => {
    for (const code of WORKER_CODES) {
      expect(GENERATION_ERRORS[code], code).toBeTruthy();
      expect(generationError(code)).toBe(GENERATION_ERRORS[code]);
    }
  });

  it("maps unknown codes to the internal copy and null to null", () => {
    expect(generationError("something_new")).toBe(GENERATION_ERRORS.internal);
    expect(generationError(null)).toBeNull();
  });
});

describe("sendFailure", () => {
  it("explains unconfirmed and rejected sends, and says nothing was sent for save errors", () => {
    expect(sendFailure("send_unconfirmed")).toMatch(/may or may not have gone out/);
    expect(sendFailure("send_rejected")).toMatch(/Nothing was sent/);
    expect(sendFailure("gmail_reauth")).toBe(
      "Gmail needs to be reconnected (Settings → Mailboxes). Nothing was sent.",
    );
    expect(sendFailure(null)).toBe("Something went wrong. Try again. Nothing was sent.");
  });
});

describe("sendActionError", () => {
  it("tells the user to reload to undo when the send may still go out", () => {
    const copy = sendActionError("send_still_scheduled");
    expect(copy).toMatch(/may still be sent/);
    expect(copy).toMatch(/Reload the page to undo/);
    expect(copy).not.toMatch(/Nothing was sent/);
  });
});
