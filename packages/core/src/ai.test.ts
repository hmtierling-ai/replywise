import { describe, expect, it } from "vitest";
import { CLASSIFICATION_MODELS, estimateCostUsd, isClassificationModel } from "./ai";

describe("classification models", () => {
  it("offers Opus 5.5 first and Haiku 5.5", () => {
    expect(CLASSIFICATION_MODELS.map((m) => m.id)).toEqual(["claude-opus-5-5", "claude-haiku-5-5"]);
    expect(isClassificationModel("claude-haiku-5-5")).toBe(true);
    expect(isClassificationModel("gpt-4")).toBe(false);
  });

  it("estimates cost from per-million-token prices", () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 0 };
    expect(estimateCostUsd("claude-opus-5-5", usage)).toBeCloseTo(4 + 2, 6);
    expect(estimateCostUsd("claude-haiku-5-5", usage)).toBeCloseTo(0.1 + 0.05, 6);
    expect(estimateCostUsd("unknown-model", usage)).toBeNull();
  });
});
