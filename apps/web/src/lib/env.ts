import "server-only";
import { parseEnv, type WebEnv, webEnvSchema } from "@replywise/config";

let cached: WebEnv | undefined;

/** Parsed lazily so `next build` does not require runtime secrets. */
export function getEnv(): WebEnv {
  cached ??= parseEnv(webEnvSchema, process.env);
  return cached;
}
