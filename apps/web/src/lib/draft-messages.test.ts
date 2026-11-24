import { describe, expect, it } from "vitest";
import { GENERATION_ERRORS, generationError } from "./draft-messages";

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
