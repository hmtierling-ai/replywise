import { describe, expect, it } from "vitest";
import { AiOutputError } from "./errors";
import { MAX_DRAFT_CHARS, normalizeDraft, normalizeSummary } from "./generation-schema";

describe("normalizeSummary", () => {
  it("trims and rejects empty", () => {
    expect(normalizeSummary({ summary: "  x  " })).toEqual({ summary: "x" });
    expect(() => normalizeSummary({ summary: "   " })).toThrow(AiOutputError);
  });
});

describe("normalizeDraft", () => {
  it("normalises line endings and trailing whitespace", () => {
    expect(normalizeDraft({ body: "Hi\r\n\r\nThanks  " })).toEqual({ body: "Hi\n\nThanks" });
  });
  it("rejects empty and caps length", () => {
    expect(() => normalizeDraft({ body: " \n " })).toThrow(AiOutputError);
    expect(normalizeDraft({ body: "a".repeat(MAX_DRAFT_CHARS + 5) }).body).toHaveLength(
      MAX_DRAFT_CHARS,
    );
    expect(MAX_DRAFT_CHARS).toBe(20_000);
  });
});
