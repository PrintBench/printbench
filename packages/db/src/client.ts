import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import * as schema from './schema/index'

export type Database = ReturnType<typeof createDb>['db']

/**
 * Postgres returns bigint as a string to avoid precision loss. Our bigint
 * columns hold file sizes and epoch milliseconds, both far inside JS safe
 * integer range, so parse them to numbers and spare every call site a
 * BigInt conversion.
 */
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v))

let cached: { pool: pg.Pool; db: ReturnType<typeof drizzle<typeof schema>> } | undefined

export function createDb(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env and fill it in.')
  }

  const pool = new pg.Pool({
    connectionString,
    max: Number(process.env.DATABASE_POOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
  })

  return { pool, db: drizzle(pool, { schema }) }
}

/**
 * Process-wide singleton. Both the web and worker processes are long-lived, so
 * a single pool per process is what we want.
 */
export function getDb() {
  cached ??= createDb()
  return cached.db
}

export function getPool() {
  cached ??= createDb()
  return cached.pool
}

export async function closeDb() {
  await cached?.pool.end()
  cached = undefined
}
