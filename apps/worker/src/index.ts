/**
 * Worker process. Runs everything that must not block page rendering:
 * library scanning, geometry analysis, thumbnail rendering, resumable uploads
 * and streaming ZIP downloads.
 *
 * Shares packages/db|core|mesh|jobs with the web app, and imports neither React
 * nor Next. Auth is a web-tier concern and is deliberately absent here.
 */
import { createServer } from 'node:http'
import { sql } from 'drizzle-orm'
import { loadRootEnv } from '@pm/core'
import { createDb } from '@pm/db'

// Must run before createDb reads DATABASE_URL.
loadRootEnv()

const PORT = Number(process.env.WORKER_PORT ?? 3001)

const { pool, db } = createDb()

const server = createServer((req, res) => {
  if (req.url === '/api/upload/health' || req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok', role: 'worker' }))
    return
  }
  // Upload (tus) and ZIP streaming routes land here from Phase 4 and 6.
  res.writeHead(404, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: 'not found' }))
})

async function main(): Promise<void> {
  await db.execute(sql`select 1`)
  console.log('[worker] database reachable')

  await new Promise<void>((resolve) => server.listen(PORT, resolve))
  console.log(`[worker] listening on :${PORT}`)

  // pg-boss registration lands in Phase 2, when the scan pipeline arrives.
  console.log('[worker] ready — no job handlers registered yet (phase 0)')
}

/**
 * Graceful shutdown. Docker sends SIGTERM and waits 10s before SIGKILL; a job
 * killed mid-write is exactly how a library index gets corrupted, so stop
 * accepting work and drain first.
 */
let shuttingDown = false
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[worker] ${signal} received, shutting down`)

  const timer = setTimeout(() => {
    console.error('[worker] drain timed out, exiting anyway')
    process.exit(1)
  }, 15_000)
  timer.unref()

  try {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await pool.end()
    console.log('[worker] clean shutdown')
    process.exit(0)
  } catch (error) {
    console.error('[worker] error during shutdown:', error)
    process.exit(1)
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))

main().catch((error) => {
  console.error('[worker] failed to start:', error)
  process.exit(1)
})
