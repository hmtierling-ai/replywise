import { describe, expect, it } from "vitest";
import { htmlToText, stripQuotedReply } from "./text";

describe("htmlToText", () => {
  it("drops scripts and styles, keeps line breaks and decodes entities", () => {
    const html =
      "<style>p{}</style><p>Hello&nbsp;<b>Ada</b></p><script>x()</script><p>a &amp; b &lt;c&gt; &#8364; &#x41;</p>";
    expect(htmlToText(html)).toBe("Hello Ada\na & b <c> € A");
  });

  it("matches whole tag names only", () => {
    expect(htmlToText("<header>Hi</header><p>there</p>")).toBe("Hi\nthere");
    expect(htmlToText("<styled>Hi</styled>")).toBe("Hi");
    expect(htmlToText("<scripts>Hi</scripts>")).toBe("Hi");
  });

  it("drops everything after an unclosed script so its content never leaks", () => {
    expect(htmlToText("<script>evil()")).toBe("");
  });

  it("keeps the rest as text when a '<' has no later '>'", () => {
    expect(htmlToText("a <b c")).toBe("a <b c");
  });

  it("finishes adversarial input quickly", () => {
    for (const input of ["<".repeat(200_000), "<script".repeat(30_000)]) {
      const start = performance.now();
      htmlToText(input);
      expect(performance.now() - start).toBeLessThan(500);
    }
  });

  it("does not decode lone surrogates or C0 controls", () => {
    expect(htmlToText("&#xD800;&#1;&#9;x")).toBe("&#xD800;&#1; x");
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
  it("keeps a 'From:' line that is not a forwarded header", () => {
    expect(stripQuotedReply("From: now on we use X\nThanks")).toBe("From: now on we use X\nThanks");
  });
  it("cuts a forwarded header block that starts with 'From:'", () => {
    const text = "Thanks\nFrom: A <a@x>\nSent: Mon\nTo: me\nSubject: hi\n\nold";
    expect(stripQuotedReply(text)).toBe("Thanks");
  });
  it("recognises the Portuguese forwarded header fields", () => {
    expect(stripQuotedReply("Ok\nFrom: A\nEnviado: seg\nPara: eu\nAssunto: oi\nvelho")).toBe("Ok");
  });
});
