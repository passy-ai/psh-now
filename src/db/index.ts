import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "../env";
import * as schema from "./schema";

/**
 * Single shared postgres.js pool + Drizzle client.
 * `max` keeps the pool bounded; `idle_timeout` recycles stale sockets.
 */
// A managed Postgres reached over the internet needs TLS, and a pooled endpoint
// (Prisma, pgbouncer, Supabase) needs prepared statements off, because the pooler
// hands each one to a different backend. Both are properties of the URL rather than
// of the deployment, so local and deployed can point at the same database.
const url = env.databaseUrl;
const pooled = /pooled\.db\.prisma\.io|pgbouncer|\/\/[^/]*:6543\//i.test(url);
const tls = /sslmode=require/i.test(url) || pooled;

/**
 * Diagnostic: prints every statement and the gap since the previous one, so "slow" can be
 * attributed to the number of round trips rather than guessed at. Gated by PSH_SQL_DEBUG.
 */
const sqlDebug =
  process.env.PSH_SQL_DEBUG === "1"
    ? (_connection: number, query: string) => {
        const now = performance.now();
        const last = (globalThis as { __lastSql?: number }).__lastSql ?? now;
        (globalThis as { __lastSql?: number }).__lastSql = now;
        console.log(`[sql +${(now - last).toFixed(0)}ms] ${query.replace(/\s+/g, " ").slice(0, 110)}`);
      }
    : undefined;

export const sql = postgres(url, {
  ...(sqlDebug ? { debug: sqlDebug } : {}),
  max: 10,
  // Measured on this machine, where the database is reached through a tunnel: a new
  // connection costs 5 to 6 seconds (handshake over the tunnel) while a query on an
  // established one costs about 0.1. So connections are kept, not recycled every 20
  // seconds of quiet, and TCP keepalive holds them open. postgres.js takes the keepalive
  // interval in seconds, not a flag: 60 is its default and what "on" means.
  idle_timeout: 0,
  keep_alive: 60,
  connect_timeout: 20,
  // Drizzle handles transformation; disable implicit number coercion surprises.
  transform: undefined,
  ...(tls ? { ssl: "require" as const } : {}),
  ...(pooled ? { prepare: false } : {}),
});


export const db = drizzle(sql, { schema });

/**
 * Pay the tunnel handshake once, at start-up, rather than on somebody's first page load.
 * Failure is not fatal: the pool retries on the next real query.
 */
void sql`select 1`.catch((err: unknown) => {
  console.error("[db] warm-up failed:", err instanceof Error ? err.message : err);
});

export type Database = typeof db;
export * from "./schema";
