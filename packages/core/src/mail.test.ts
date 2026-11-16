import { describe, expect, it } from "vitest";
import { isMailProviderId } from "./mail";

describe("isMailProviderId", () => {
  it("accepts the supported providers only", () => {
    expect(isMailProviderId("gmail")).toBe(true);
    expect(isMailProviderId("outlook")).toBe(true);
    expect(isMailProviderId("yahoo")).toBe(false);
    expect(isMailProviderId("GMAIL")).toBe(false);
    expect(isMailProviderId("")).toBe(false);
  });
});
