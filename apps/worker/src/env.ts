import { parseEnv, workerEnvSchema } from "@replywise/config";

export const env = parseEnv(workerEnvSchema, process.env);
