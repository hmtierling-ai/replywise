import type { EmailAddress } from "@replywise/core";
import { decodeEncodedWords } from "./encoded-words";

function splitAddresses(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inQuotes = false;
  let depth = 0;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i] as string;
    if (ch === "\\" && inQuotes) {
      current += ch + (value[i + 1] ?? "");
      i++;
      continue;
    }
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && ch === "<") depth++;
    else if (!inQuotes && ch === ">") depth = Math.max(0, depth - 1);
    if (ch === "," && !inQuotes && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

function cleanName(raw: string): string | null {
  let name = decodeEncodedWords(raw.trim());
  if (name.length >= 2 && name.startsWith('"') && name.endsWith('"')) {
    name = name.slice(1, -1).replace(/\\(.)/g, "$1");
  }
  name = name.trim();
  return name === "" ? null : name;
}

function parseOne(raw: string): EmailAddress | null {
  const text = raw.trim();
  if (text === "") return null;
  const angle = /^([\s\S]*)<([^<>]+)>\s*$/.exec(text);
  if (angle) {
    const address = (angle[2] ?? "").trim().toLowerCase();
    return address.includes("@") ? { name: cleanName(angle[1] ?? ""), address } : null;
  }
  const address = text.replace(/\s*\([^)]*\)\s*$/, "").toLowerCase();
  return address.includes("@") && !/\s/.test(address) ? { name: null, address } : null;
}

/** Parses an RFC 5322 address-list header value ("Name <a@b>, c@d"). Groups are dropped. */
export function parseAddressList(value: string | undefined): EmailAddress[] {
  if (!value) return [];
  return splitAddresses(value)
    .map(parseOne)
    .filter((a): a is EmailAddress => a !== null);
}
