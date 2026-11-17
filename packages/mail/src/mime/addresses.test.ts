import { describe, expect, it } from "vitest";
import { parseAddressList } from "./addresses";

describe("parseAddressList", () => {
  it("parses names and lowercases addresses", () => {
    expect(parseAddressList("Ada Lovelace <Ada@Example.com>")).toEqual([
      { name: "Ada Lovelace", address: "ada@example.com" },
    ]);
  });

  it("keeps commas inside quoted names and handles bare addresses", () => {
    expect(parseAddressList('"Doe, John" <john@x.com>, jane@y.com')).toEqual([
      { name: "Doe, John", address: "john@x.com" },
      { name: null, address: "jane@y.com" },
    ]);
  });

  it("decodes encoded-word names and escaped quotes", () => {
    expect(parseAddressList("=?UTF-8?B?w4lsw6huZQ==?= <e@x.com>")).toEqual([
      { name: "Élène", address: "e@x.com" },
    ]);
    expect(parseAddressList('"Quote \\"Q\\" Person" <q@x.com>')).toEqual([
      { name: 'Quote "Q" Person', address: "q@x.com" },
    ]);
  });

  it("drops groups and empty input", () => {
    expect(parseAddressList("undisclosed-recipients:;")).toEqual([]);
    expect(parseAddressList(undefined)).toEqual([]);
    expect(parseAddressList("")).toEqual([]);
  });
});
