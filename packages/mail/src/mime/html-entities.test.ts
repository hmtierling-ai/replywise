import { describe, expect, it } from "vitest";
import { decodeHtmlEntities } from "./html-entities";

describe("decodeHtmlEntities", () => {
  it("decodes named entities", () => {
    expect(decodeHtmlEntities("&amp; &lt; &gt; &quot; &apos; &nbsp;")).toBe("& < > \" '  ");
  });

  it("decodes decimal and hex numeric entities", () => {
    expect(decodeHtmlEntities("It&#39;s")).toBe("It's");
    expect(decodeHtmlEntities("It&#x27;s")).toBe("It's");
  });

  it("leaves unknown named entities unchanged", () => {
    expect(decodeHtmlEntities("&foo;")).toBe("&foo;");
  });

  it("leaves out-of-range numeric entities unchanged without throwing", () => {
    expect(decodeHtmlEntities("&#1114112;")).toBe("&#1114112;");
    expect(decodeHtmlEntities("&#x110000;")).toBe("&#x110000;");
  });

  it("leaves &#0; unchanged", () => {
    expect(decodeHtmlEntities("&#0;")).toBe("&#0;");
  });
});
