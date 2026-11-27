import { describe, expect, it } from "vitest";
import { escapeLikePattern } from "./search";

describe("escapeLikePattern", () => {
  it("escapes LIKE wildcards and the escape character", () => {
    expect(escapeLikePattern("50%_off\\now")).toBe("50\\%\\_off\\\\now");
  });
  it("leaves ordinary text alone", () => {
    expect(escapeLikePattern("Ada Lovelace <ada@x.com>")).toBe("Ada Lovelace <ada@x.com>");
  });
});
