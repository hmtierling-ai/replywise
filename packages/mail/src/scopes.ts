const GRAPH_PREFIX = /^https:\/\/graph\.microsoft\.com\//i;

export function parseScopes(value: string | undefined): string[] {
  return (value ?? "").split(/\s+/).filter(Boolean);
}

export function normalizeScope(scope: string): string {
  return scope.trim().replace(GRAPH_PREFIX, "").toLowerCase();
}

export function missingScopes(granted: readonly string[], required: readonly string[]): string[] {
  const have = new Set(granted.map(normalizeScope));
  return required.filter((scope) => !have.has(normalizeScope(scope)));
}
