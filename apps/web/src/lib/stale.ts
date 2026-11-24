/** True when `since` is `ms` or more older than `now` (a stuck or abandoned request). */
export function isOlderThan(since: Date, now: Date, ms: number): boolean {
  return now.getTime() - since.getTime() >= ms;
}
