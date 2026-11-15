import { describe, expect, it } from "vitest";
import { securityHeaders } from "./security-headers";

const asMap = (isProduction: boolean) =>
  Object.fromEntries(securityHeaders(isProduction).map((h) => [h.key, h.value]));

describe("securityHeaders", () => {
  it("forbids framing and MIME sniffing in every environment", () => {
    for (const headers of [asMap(true), asMap(false)]) {
      expect(headers["X-Frame-Options"]).toBe("DENY");
      expect(headers["X-Content-Type-Options"]).toBe("nosniff");
      expect(headers["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
      expect(headers["Content-Security-Policy"]).toContain("object-src 'none'");
    }
  });

  it("only allows eval and enables HSTS where appropriate", () => {
    expect(asMap(false)["Content-Security-Policy"]).toContain("'unsafe-eval'");
    expect(asMap(true)["Content-Security-Policy"]).not.toContain("'unsafe-eval'");
    expect(asMap(true)["Strict-Transport-Security"]).toMatch(/max-age=\d+/);
    expect(asMap(false)["Strict-Transport-Security"]).toBeUndefined();
  });
});
