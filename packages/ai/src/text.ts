const NAMED_ENTITIES = new Map<string, string>([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
  ["nbsp", " "],
]);

/** Numeric references to lone surrogates and C0 controls (except tab and newline) stay undecoded. */
function isDecodableCodePoint(n: number): boolean {
  if (!Number.isInteger(n) || n <= 0 || n > 0x10ffff) return false;
  if (n >= 0xd800 && n <= 0xdfff) return false;
  return n >= 0x20 || n === 0x09 || n === 0x0a;
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (match, code: string) => {
    if (code[0] === "#") {
      const n =
        code[1]?.toLowerCase() === "x" ? Number.parseInt(code.slice(2), 16) : Number(code.slice(1));
      return isDecodableCodePoint(n) ? String.fromCodePoint(n) : match;
    }
    return NAMED_ENTITIES.get(code.toLowerCase()) ?? match;
  });
}

/** Opening or closing tag name; the name is greedy, so `<header>` never matches `head`. */
const TAG_START = /<(\/?)([a-z][a-z0-9]*)/iy;

/** Blocks whose content is dropped entirely. Each closing tag must end at a name boundary. */
const RAW_CLOSE = new Map<string, RegExp>([
  ["script", /<\/script(?![a-z0-9])/gi],
  ["style", /<\/style(?![a-z0-9])/gi],
  ["head", /<\/head(?![a-z0-9])/gi],
]);

/** Tags that separate blocks of text; both opening and closing forms become a line break. */
const BLOCK_TAGS = new Set(["p", "div", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6"]);

/**
 * Single left-to-right pass: no backtracking regex runs over the whole document, so adversarial
 * input stays linear. An unclosed raw block drops the rest; a tag with no later `>` keeps the rest.
 */
function stripMarkup(html: string): string {
  const out: string[] = [];
  let pos = 0;
  // Cached result of the last `>` search. -2 means not searched; -1 means no `>` after the last start.
  let gtCache = -2;
  const findGt = (from: number): number => {
    if (gtCache === -1) return -1;
    if (gtCache >= from) return gtCache;
    gtCache = html.indexOf(">", from);
    return gtCache;
  };

  while (pos < html.length) {
    const lt = html.indexOf("<", pos);
    if (lt === -1) {
      out.push(html.slice(pos));
      break;
    }
    out.push(html.slice(pos, lt));

    TAG_START.lastIndex = lt;
    const m = TAG_START.exec(html);
    if (!m) {
      const sigil = html[lt + 1];
      if (sigil !== "!" && sigil !== "?") {
        out.push("<");
        pos = lt + 1;
        continue;
      }
      // Comments and declarations: skipped up to the next `>`.
      const gt = findGt(lt);
      if (gt === -1) {
        out.push(html.slice(lt));
        break;
      }
      pos = gt + 1;
      continue;
    }

    const gt = findGt(lt);
    if (gt === -1) {
      out.push(html.slice(lt));
      break;
    }

    const isClose = m[1] === "/";
    const name = (m[2] ?? "").toLowerCase();
    const closeRe = RAW_CLOSE.get(name);
    if (!isClose && closeRe) {
      closeRe.lastIndex = gt + 1;
      const close = closeRe.exec(html);
      if (!close) break;
      const closeGt = findGt(close.index);
      if (closeGt === -1) break;
      pos = closeGt + 1;
      continue;
    }

    if (name === "br" || BLOCK_TAGS.has(name)) out.push("\n");
    pos = gt + 1;
  }
  return out.join("");
}

/** Rough HTML → text for prompts (never rendered). */
export function htmlToText(html: string): string {
  return decodeEntities(stripMarkup(html))
    .split("\n")
    .map((line) => line.replace(/[ \t\u00a0]+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

const REPLY_HEADER = /^(on .+wrote:|em .+escreveu:|-{2,}\s*original message\s*-{2,})$/i;
const FROM_LINE = /^from:/i;
/** Fields that, after a `From:` line, mark a forwarded header block (English and Portuguese). */
const FORWARD_FIELD = /^(sent|date|to|subject|enviado|data|para|assunto):/i;

function startsForwardHeader(lines: string[], index: number): boolean {
  if (!FROM_LINE.test((lines[index] ?? "").trim())) return false;
  return lines.slice(index + 1, index + 4).some((next) => FORWARD_FIELD.test(next.trim()));
}

/** Drops quoted history so the prompt holds what each message actually says. */
export function stripQuotedReply(text: string): string {
  const lines = text.split(/\r?\n/);
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? "").trimEnd();
    if (REPLY_HEADER.test(line.trim()) || startsForwardHeader(lines, i)) break;
    if (line.trimStart().startsWith(">")) continue;
    kept.push(line);
  }
  return kept.join("\n").trim();
}
