import { describe, expect, it } from "vitest";
import { initialsFor } from "./initials";

describe("initialsFor", () => {
  it("uses the first letters of the first and last words", () => {
    expect(initialsFor("Ada Lovelace")).toBe("AL");
    expect(initialsFor("  grace   brewster murray hopper ")).toBe("GH");
  });

  it("handles single names and empty input", () => {
    expect(initialsFor("Linus")).toBe("L");
    expect(initialsFor("   ")).toBe("?");
  });
});
