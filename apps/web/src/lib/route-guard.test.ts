import { describe, expect, it } from "vitest";
import { routeDecision } from "./route-guard";

describe("routeDecision", () => {
  it("sends visitors without a session cookie to sign-in", () => {
    for (const path of ["/", "/inbox", "/inbox/urgent", "/settings"]) {
      expect(routeDecision(path, false)).toEqual({ type: "redirect", to: "/sign-in" });
    }
  });

  it("always lets visitors reach the auth pages, even with a (possibly stale) cookie", () => {
    // A cookie only proves a session *might* exist. Redirecting away from sign-in on
    // cookie presence loops forever when the session is expired or revoked; the
    // auth pages verify the real session server-side instead.
    for (const hasCookie of [true, false]) {
      expect(routeDecision("/sign-in", hasCookie)).toEqual({ type: "next" });
      expect(routeDecision("/sign-up", hasCookie)).toEqual({ type: "next" });
    }
  });

  it("lets signed-in visitors through to known views", () => {
    for (const path of ["/inbox", "/inbox/needs-reply", "/settings"]) {
      expect(routeDecision(path, true)).toEqual({ type: "next" });
    }
  });

  it("returns a real 404 for unknown inbox categories", () => {
    expect(routeDecision("/inbox/bogus", true)).toEqual({ type: "notFound" });
    expect(routeDecision("/inbox/needs_reply", true)).toEqual({ type: "notFound" });
  });
});
