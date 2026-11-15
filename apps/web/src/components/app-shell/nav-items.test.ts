import { describe, expect, it } from "vitest";
import { buildNavItems, isActive } from "./nav-items";

describe("buildNavItems", () => {
  it("lists all mail followed by every category in precedence order", () => {
    expect(buildNavItems().map((i) => [i.label, i.href])).toEqual([
      ["All mail", "/inbox"],
      ["Urgent", "/inbox/urgent"],
      ["Important", "/inbox/important"],
      ["Needs Reply", "/inbox/needs-reply"],
      ["Informational", "/inbox/informational"],
      ["Low Priority", "/inbox/low-priority"],
    ]);
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
