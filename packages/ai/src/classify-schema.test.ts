import { describe, expect, it } from "vitest";
import { normalizeClassifyOutput } from "./classify-schema";

describe("normalizeClassifyOutput", () => {
  it("clamps scores, trims and caps reasons", () => {
    expect(
      normalizeClassifyOutput({
        urgency: 9,
        importance: 0,
        needs_reply: true,
        reasons: ["  First.  ", "", "Second.", "Third.", "Fourth.", "x".repeat(400)],
      }),
    ).toEqual({
      urgency: 5,
      importance: 1,
      needsReply: true,
      reasons: ["First.", "Second.", "Third."],
    });
  });
  it("maps non-finite scores to the lowest score", () => {
    const result = normalizeClassifyOutput({
      urgency: Number.NaN,
      importance: Number.POSITIVE_INFINITY,
      needs_reply: false,
      reasons: ["Ok."],
    });
    expect(result.urgency).toBe(1);
    expect(result.importance).toBe(1);
  });
  it("supplies a neutral reason when none is given", () => {
    expect(
      normalizeClassifyOutput({ urgency: 2.6, importance: 3, needs_reply: false, reasons: [] })
        .reasons,
    ).toEqual(["No explanation was provided."]);
  });
});
