import { z } from "zod";

const KEK_LIST = /^[\w-]+:[A-Za-z0-9+/]+=*(,[\w-]+:[A-Za-z0-9+/]+=*)*$/;

export const baseEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
  LOCAL_KEKS: z.string().regex(KEK_LIST, "expected id:base64[,id:base64...]"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  GMAIL_CLIENT_ID: z.string().min(1).optional(),
  GMAIL_CLIENT_SECRET: z.string().min(1).optional(),
  OUTLOOK_CLIENT_ID: z.string().min(1).optional(),
  OUTLOOK_CLIENT_SECRET: z.string().min(1).optional(),
});

export const workerEnvSchema = baseEnvSchema;

export const webEnvSchema = baseEnvSchema.extend({
  APP_URL: z.url(),
  BETTER_AUTH_SECRET: z.string().min(32),
  GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
});

export type WorkerEnv = z.output<typeof workerEnvSchema>;
export type WebEnv = z.output<typeof webEnvSchema>;

export class EnvValidationError extends Error {
  constructor(readonly invalidKeys: string[]) {
    super(`Invalid or missing environment variables: ${invalidKeys.join(", ")}`);
    this.name = "EnvValidationError";
  }
}

export function parseEnv<S extends z.ZodType>(
  schema: S,
  source: Record<string, string | undefined>,
): z.output<S> {
  const cleaned = Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined && value !== ""),
  );
  const result = schema.safeParse(cleaned);
  if (!result.success) {
    const keys = new Set(result.error.issues.map((issue) => String(issue.path[0] ?? "(root)")));
    throw new EnvValidationError([...keys].sort());
  }
  return result.data;
}
