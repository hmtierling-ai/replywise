import { type DestinationStream, type Logger, pino } from "pino";

const SENSITIVE_KEYS = [
  "password",
  "apiKey",
  "accessToken",
  "refreshToken",
  "idToken",
  "token",
  "codeVerifier",
  "authorization",
  "cookie",
  "body",
  "bodyText",
  "bodyHtml",
] as const;

/**
 * Defense in depth only: redaction covers the top level and one level of nesting.
 * Code must still never pass secrets or email content to the logger.
 */
export const REDACT_PATHS: string[] = [
  ...SENSITIVE_KEYS,
  ...SENSITIVE_KEYS.map((key) => `*.${key}`),
];

export interface CreateLoggerOptions {
  name: string;
  level?: string;
}

export function createLogger(
  options: CreateLoggerOptions,
  destination?: DestinationStream,
): Logger {
  const config = {
    level: options.level ?? "info",
    base: { service: options.name },
    redact: { paths: REDACT_PATHS, censor: "[Redacted]" },
    timestamp: pino.stdTimeFunctions.isoTime,
  };
  return destination ? pino(config, destination) : pino(config);
}

export type { Logger };
