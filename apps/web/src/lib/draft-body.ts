export const MAX_BODY = 20_000;

/** Line endings to \n and the length cap: the one canonical form a draft body is stored in. */
export function normalizeBody(raw: string): string {
  return raw.replace(/\r\n?/g, "\n").slice(0, MAX_BODY);
}
