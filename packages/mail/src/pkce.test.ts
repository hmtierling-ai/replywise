import { describe, expect, it } from "vitest";
import { codeChallengeS256, hashState, randomToken } from "./pkce";

describe("PKCE helpers", () => {
  it("matches the RFC 7636 Appendix B test vector", () => {
    expect(codeChallengeS256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("generates unpredictable URL-safe tokens of the requested strength", () => {
    const a = randomToken();
    const b = randomToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken(48)).toHaveLength(64);
  });

  it("hashes state to 64 hex chars without echoing it", () => {
    const hash = hashState("some-state");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(hashState("some-state"));
    expect(hash).not.toBe(hashState("other-state"));
  });
});
