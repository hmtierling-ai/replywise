import { describe, expect, it } from "vitest";
import { CATEGORY_META, categoryFromSlug, INBOX_CATEGORIES } from "./categories";

describe("inbox categories", () => {
  it("are listed in precedence order", () => {
    expect(INBOX_CATEGORIES).toEqual([
      "urgent",
      "important",
      "needs_reply",
      "informational",
      "low_priority",
    ]);
  });

  it("have unique, URL-safe slugs", () => {
    const slugs = INBOX_CATEGORIES.map((c) => CATEGORY_META[c].slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) expect(slug).toMatch(/^[a-z]+(-[a-z]+)*$/);
  });

  it("round-trip through categoryFromSlug", () => {
    for (const category of INBOX_CATEGORIES) {
      expect(categoryFromSlug(CATEGORY_META[category].slug)).toBe(category);
    }
  });

  it("reject unknown slugs and raw enum values", () => {
    expect(categoryFromSlug("spam")).toBeNull();
    expect(categoryFromSlug("needs_reply")).toBeNull();
    expect(categoryFromSlug("")).toBeNull();
  });
});
