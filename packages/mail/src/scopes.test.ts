import { describe, expect, it } from "vitest";
import { missingScopes, normalizeScope, parseScopes } from "./scopes";

describe("scopes", () => {
  it("parses space-separated scope strings", () => {
    expect(parseScopes("a  b\tc")).toEqual(["a", "b", "c"]);
    expect(parseScopes(undefined)).toEqual([]);
    expect(parseScopes("")).toEqual([]);
  });

  it("normalizes Microsoft Graph resource prefixes and case", () => {
    expect(normalizeScope("https://graph.microsoft.com/Mail.ReadWrite")).toBe("mail.readwrite");
    expect(normalizeScope("User.Read")).toBe("user.read");
  });

  it("reports required scopes the user did not grant", () => {
    const required = [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.compose",
    ];
    expect(missingScopes(["https://www.googleapis.com/auth/gmail.readonly"], required)).toEqual([
      "https://www.googleapis.com/auth/gmail.compose",
    ]);
    expect(missingScopes(required, required)).toEqual([]);
    expect(
      missingScopes(
        ["https://graph.microsoft.com/User.Read", "mail.readwrite"],
        ["User.Read", "Mail.ReadWrite"],
      ),
    ).toEqual([]);
  });
});
