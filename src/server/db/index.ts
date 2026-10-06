import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const globalForDb = globalThis as unknown as { __fdPool?: pg.Pool };

const pool =
  globalForDb.__fdPool ??
  new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: Number(process.env.DATABASE_POOL_SIZE ?? 10),
  });

if (process.env.NODE_ENV !== "production") globalForDb.__fdPool = pool;

export const db = drizzle({ client: pool, schema });
export type DB = typeof db;
export { schema, pool };
