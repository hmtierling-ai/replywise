import { describe, expect, it } from "vitest";
import { routeDecision } from "./route-guard";

describe("routeDecision", () => {
  it("sends visitors without a session cookie to sign-in", () => {
    for (const path of ["/", "/inbox", "/inbox/urgent", "/settings"]) {
      expect(routeDecision(path, false)).toEqual({ type: "redirect", to: "/sign-in" });
    }
  });

  it("sends signed-in visitors away from the auth pages", () => {
    expect(routeDecision("/sign-in", true)).toEqual({ type: "redirect", to: "/inbox" });
    expect(routeDecision("/sign-up", true)).toEqual({ type: "redirect", to: "/inbox" });
  });

  it("lets visitors without a session reach the auth pages", () => {
    expect(routeDecision("/sign-in", false)).toEqual({ type: "next" });
    expect(routeDecision("/sign-up", false)).toEqual({ type: "next" });
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
