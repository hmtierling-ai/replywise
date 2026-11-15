import "server-only";
import { createDb, type Db } from "@replywise/db";
import { getEnv } from "./env";

const globalForDb = globalThis as unknown as { replywiseDb?: Db };

/** One pool per process; survives dev hot reloads. */
export function getDb(): Db {
  globalForDb.replywiseDb ??= createDb(getEnv().DATABASE_URL).db;
  return globalForDb.replywiseDb;
}
