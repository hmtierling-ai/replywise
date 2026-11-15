import { createLogger } from "@replywise/observability";
import { env } from "./env";
import { startWorker } from "./main";

const logger = createLogger({ name: "worker", level: env.LOG_LEVEL });
const worker = await startWorker(env, logger);

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, "shutting down");
  try {
    await worker.stop();
    process.exit(0);
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      "shutdown failed",
    );
    process.exit(1);
  }
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
