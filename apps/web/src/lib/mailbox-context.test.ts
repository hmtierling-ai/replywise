import { describe, expect, it } from "vitest";
import { requestContext } from "./request-context";

describe("requestContext", () => {
  it("takes the leftmost forwarded ip", () => {
    const h = new Headers({ "x-forwarded-for": "1.2.3.4, 5.6.7.8", "user-agent": "ua" });
    expect(requestContext(h)).toEqual({ ip: "1.2.3.4", userAgent: "ua" });
  });
  it("returns null ip when absent or empty", () => {
    expect(requestContext(new Headers()).ip).toBeNull();
    expect(requestContext(new Headers({ "x-forwarded-for": " , 1.1.1.1" })).ip).toBeNull();
  });
  it("caps the ip at 64 characters", () => {
    const h = new Headers({ "x-forwarded-for": "a".repeat(500) });
    expect(requestContext(h).ip).toHaveLength(64);
  });
});
