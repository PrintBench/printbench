import { sql } from 'drizzle-orm'
import { getDb } from '@pb/db'

// Always hit the database; a cached health check tells you nothing.
export const dynamic = 'force-dynamic'

/**
 * Liveness + readiness in one. Returns 503 when the database is unreachable so
 * Docker and Coolify health checks fail loudly rather than serving a broken app.
 */
export async function GET() {
  const startedAt = performance.now()
  try {
    await getDb().execute(sql`select 1`)
    return Response.json({
      status: 'ok',
      database: 'up',
      latencyMs: Math.round(performance.now() - startedAt),
    })
  } catch (error) {
    return Response.json(
      {
        status: 'degraded',
        database: 'down',
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 503 },
    )
  }
}
