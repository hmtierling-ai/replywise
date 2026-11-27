import { describe, expect, it } from "vitest";
import { buildNavItems, isActive, navCount } from "./nav-items";

describe("buildNavItems", () => {
  it("lists all mail, every category in precedence order, then Other and Sent", () => {
    expect(buildNavItems().map((i) => [i.label, i.href, i.countKey ?? null])).toEqual([
      ["All mail", "/inbox", "inbox"],
      ["Urgent", "/inbox/urgent", "urgent"],
      ["Important", "/inbox/important", "important"],
      ["Needs Reply", "/inbox/needs-reply", "needs_reply"],
      ["Informational", "/inbox/informational", "informational"],
      ["Low Priority", "/inbox/low-priority", "low_priority"],
      ["Other", "/other", "other"],
      ["Sent", "/sent", null],
    ]);
  });
});

describe("navCount", () => {
  const counts = {
    inbox: 7,
    other: 3,
    categories: { urgent: 1, important: 0, needs_reply: 2, informational: 4, low_priority: 0 },
  };
  it("reads the count for a key, or null without counts or key", () => {
    expect(navCount(counts, "inbox")).toBe(7);
    expect(navCount(counts, "other")).toBe(3);
    expect(navCount(counts, "needs_reply")).toBe(2);
    expect(navCount(counts, undefined)).toBeNull();
    expect(navCount(null, "inbox")).toBeNull();
  });
});

describe("isActive", () => {
  it("matches All mail only on /inbox exactly", () => {
    expect(isActive("/inbox", "/inbox")).toBe(true);
    expect(isActive("/inbox/urgent", "/inbox")).toBe(false);
  });

  it("matches a section and its children", () => {
    expect(isActive("/inbox/urgent", "/inbox/urgent")).toBe(true);
    expect(isActive("/settings/mailboxes", "/settings")).toBe(true);
    expect(isActive("/inbox/urgent-ish", "/inbox/urgent")).toBe(false);
  });
});
