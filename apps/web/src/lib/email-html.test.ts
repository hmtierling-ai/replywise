import { describe, expect, it } from "vitest";
import { buildEmailDocument, gmailThreadUrl, sanitizeEmailHtml } from "./email-html";

describe("sanitizeEmailHtml", () => {
  it("removes scripts, event handlers, styles, forms and javascript: links", () => {
    const clean = sanitizeEmailHtml(
      '<p onclick="steal()">Hi</p><script>alert(1)</script><style>body{}</style>' +
        '<form action="https://evil"><input name="pw"></form><a href="javascript:alert(1)">x</a>',
    );
    expect(clean).toContain("<p>Hi</p>");
    expect(clean).not.toMatch(/script|onclick|<style|<form|<input|javascript:/i);
  });

  it("blocks remote images but keeps inline data images and formatting", () => {
    const clean = sanitizeEmailHtml(
      '<img src="https://tracker.example/p.gif"><img src="data:image/png;base64,AAAA" alt="logo">' +
        "<table><tr><td><b>bold</b> <i>it</i></td></tr></table>",
    );
    expect(clean).not.toContain("tracker.example");
    expect(clean).toContain('src="data:image/png;base64,AAAA"');
    expect(clean).toContain("<table>");
    expect(clean).toContain("<b>bold</b>");
  });

  it("opens links in a new tab without referrer", () => {
    expect(sanitizeEmailHtml('<a href="https://example.com/x">x</a>')).toBe(
      '<a href="https://example.com/x" target="_blank" rel="noopener noreferrer nofollow">x</a>',
    );
  });
});

describe("buildEmailDocument", () => {
  it("wraps the html in a document that opens links outside the frame", () => {
    const doc = buildEmailDocument("<p>Hi</p>");
    expect(doc).toMatch(/^<!doctype html>/i);
    expect(doc).toContain('<base target="_blank">');
    expect(doc).toContain("<p>Hi</p>");
  });
});

describe("gmailThreadUrl", () => {
  it("deep-links to the thread in the right Gmail account", () => {
    expect(gmailThreadUrl("me@gmail.com", "18c2")).toBe(
      "https://mail.google.com/mail/u/?authuser=me%40gmail.com#all/18c2",
    );
  });
});
