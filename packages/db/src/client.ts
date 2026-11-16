import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index";

export function createDb(url: string, options: { max?: number } = {}) {
  const client = postgres(url, { max: options.max ?? 10 });
  const db = drizzle({ client, schema });
  return { db, close: () => client.end() };
}

export type Db = ReturnType<typeof createDb>["db"];

export type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** Query functions accept either the pool or an open transaction. */
export type DbExecutor = Db | DbTransaction;
