import sanitizeHtml from "sanitize-html";

const ALLOWED_TAGS = [
  "a",
  "abbr",
  "b",
  "blockquote",
  "br",
  "caption",
  "center",
  "code",
  "dd",
  "div",
  "dl",
  "dt",
  "em",
  "font",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "i",
  "img",
  "li",
  "ol",
  "p",
  "pre",
  "s",
  "small",
  "span",
  "strong",
  "sub",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "u",
  "ul",
];

/** Server-side sanitizer for email HTML: no scripts, handlers, styles, forms or remote images. */
export function sanitizeEmailHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: {
      a: ["href", "title", "target", "rel"],
      img: ["src", "alt", "width", "height"],
      td: ["colspan", "rowspan", "align", "valign", "width"],
      th: ["colspan", "rowspan", "align", "valign", "width"],
      table: ["width", "align", "cellpadding", "cellspacing", "border"],
      "*": ["dir"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesByTag: { img: ["data"] },
    allowProtocolRelative: false,
    disallowedTagsMode: "discard",
    transformTags: {
      a: sanitizeHtml.simpleTransform("a", {
        target: "_blank",
        rel: "noopener noreferrer nofollow",
      }),
    },
    exclusiveFilter: (frame) => frame.tag === "img" && !frame.attribs.src,
  });
}

/** Wraps sanitized HTML for an <iframe srcDoc>; links open outside the frame. */
export function buildEmailDocument(sanitizedHtml: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>body{margin:0;padding:16px;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;font-size:14px;line-height:1.55;color:#18181b;background:#fff;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}a{color:#2563eb}blockquote{margin:0 0 0 8px;padding-left:12px;border-left:2px solid #e4e4e7;color:#52525b}</style></head><body>${sanitizedHtml}</body></html>`;
}

export function gmailThreadUrl(email: string, providerThreadId: string): string {
  return `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(email)}#all/${encodeURIComponent(providerThreadId)}`;
}
