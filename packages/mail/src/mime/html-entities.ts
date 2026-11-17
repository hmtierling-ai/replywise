const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

const MAX_CODE_POINT = 0x10ffff;

function fromCodePoint(code: number, original: string): string {
  return Number.isFinite(code) && code > 0 && code <= MAX_CODE_POINT
    ? String.fromCodePoint(code)
    : original;
}

/** Decodes the entities Gmail puts in snippets (&amp; &#39; &#x27; …). Text only. */
export function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      return fromCodePoint(Number.parseInt(entity.slice(2), 16), match);
    }
    if (entity.startsWith("#")) {
      return fromCodePoint(Number.parseInt(entity.slice(1), 10), match);
    }
    return NAMED[entity.toLowerCase()] ?? match;
  });
}
