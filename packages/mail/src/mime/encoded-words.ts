const ENCODED_WORD = /=\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=/g;
const ADJACENT_GAP = /(=\?[^?\s]+\?[BbQq]\?[^?\s]*\?=)\s+(?==\?)/g;

function decodeQ(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    const hex = text.slice(i + 1, i + 3);
    if (ch === "_") out.push(0x20);
    else if (ch === "=" && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      out.push(Number.parseInt(hex, 16));
      i += 2;
    } else out.push(ch.charCodeAt(0));
  }
  return Uint8Array.from(out);
}

function normalizeCharset(charset: string): string {
  const lower = (charset.split("*")[0] ?? charset).toLowerCase();
  return lower === "utf8" ? "utf-8" : lower;
}

/** Decodes RFC 2047 encoded words (`=?charset?B|Q?…?=`); leaves anything else untouched. */
export function decodeEncodedWords(value: string): string {
  return value
    .replace(ADJACENT_GAP, "$1")
    .replace(ENCODED_WORD, (match, charset: string, encoding: string, text: string) => {
      try {
        const bytes = encoding.toUpperCase() === "B" ? Buffer.from(text, "base64") : decodeQ(text);
        return new TextDecoder(normalizeCharset(charset)).decode(bytes);
      } catch {
        return match;
      }
    });
}
