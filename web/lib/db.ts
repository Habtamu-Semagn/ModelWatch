import { Pool } from "pg";

// One pool per server process. The Next.js app is READ-ONLY: it never writes.
const globalForPg = globalThis as unknown as { evalkitPool?: Pool };

export const pool =
  globalForPg.evalkitPool ??
  new Pool({
    connectionString:
      process.env.DATABASE_URL ?? "postgres://evalkit:evalkit@localhost:55432/evalkit",
    max: 4,
  });

if (process.env.NODE_ENV !== "production") globalForPg.evalkitPool = pool;