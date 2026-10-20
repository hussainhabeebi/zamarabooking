import { drizzle } from "drizzle-orm/neon-http";
import { neon } from "@neondatabase/serverless";
import * as schema from "./schema/index.js";

// Edge-compatible Neon client (used inside CF Workers via Hyperdrive)
export function createDb(connectionString: string) {
  const sql = neon(connectionString);
  return drizzle(sql, { schema, logger: process.env.NODE_ENV !== "production" });
}

export type Db = ReturnType<typeof createDb>;
export { schema };
