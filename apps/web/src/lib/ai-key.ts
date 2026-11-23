const ANTHROPIC_KEY = /^sk-ant-[A-Za-z0-9_-]{20,}$/;

export function parseAnthropicKey(raw: string): string | null {
  const key = raw.trim();
  return ANTHROPIC_KEY.test(key) ? key : null;
}

export function keyHint(key: string): string {
  return key.slice(-4);
}
