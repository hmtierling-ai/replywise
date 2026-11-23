import { describe, expect, it } from "vitest";
import { htmlToText, stripQuotedReply } from "./text";

describe("htmlToText", () => {
  it("drops scripts and styles, keeps line breaks and decodes entities", () => {
    const html =
      "<style>p{}</style><p>Hello&nbsp;<b>Ada</b></p><script>x()</script><p>a &amp; b &lt;c&gt; &#8364; &#x41;</p>";
    expect(htmlToText(html)).toBe("Hello Ada\na & b <c> € A");
  });
});

describe("stripQuotedReply", () => {
  it("cuts at an 'On … wrote:' line and drops '>' quoted lines", () => {
    const text = "Sounds good.\n> earlier line\nThanks\nOn Mon, Ada <a@x.com> wrote:\n> old";
    expect(stripQuotedReply(text)).toBe("Sounds good.\nThanks");
  });
  it("handles the Portuguese 'Em … escreveu:' header", () => {
    expect(stripQuotedReply("Combinado!\nEm seg., Ada escreveu:\nantigo")).toBe("Combinado!");
  });
});
