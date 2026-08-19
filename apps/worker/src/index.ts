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
import { JOB, getQueue } from '@pm/jobs'
import { handleLibraryScan } from './jobs/scan'
import { handleFileAnalyze, handleFileDigest, handleFileThumbnail } from './jobs/analyze'

// Must run before anything reads DATABASE_URL.
loadRootEnv()

const PORT = Number(process.env.WORKER_PORT ?? 3001)

const { pool, db } = createDb()

/*
 * The shared singleton, NOT a fresh JobQueue.
 *
 * Job handlers reach the queue through getQueue() to fan out follow-up work.
 * If this process started a different instance, that call would return an
 * unstarted queue and every enqueue from inside a handler would throw — which
 * is exactly what happened when the scan tried to queue thumbnail work.
 */
const queue = getQueue()

const server = createServer((req, res) => {
  if (req.url === '/api/upload/health' || req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok', role: 'worker' }))
    return
  }
  // Upload (tus) and ZIP streaming routes land here from phases 4 and 6.
  res.writeHead(404, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: 'not found' }))
})

async function main(): Promise<void> {
  await db.execute(sql`select 1`)
  console.log('[worker] database reachable')

  await queue.start()
  console.log('[worker] job queue ready')

  await queue.work(JOB.libraryScan, handleLibraryScan)
  await queue.work(JOB.fileAnalyze, handleFileAnalyze)
  await queue.work(JOB.fileThumbnail, handleFileThumbnail)
  await queue.work(JOB.fileDigest, handleFileDigest)
  console.log('[worker] handlers: library.scan, file.analyze, file.thumbnail, file.digest')

  /*
   * Hourly fast scan of every enabled library, plus a weekly deep scan.
   *
   * The split matters: a fast scan trusts directory mtimes, which do not change
   * when an existing file's bytes are edited in place. The deep scan re-examines
   * everything and catches those.
   */
  await queue.schedule(JOB.maintReconcile, '*/15 * * * *', {})
  console.log('[worker] scheduled: maintenance sweep every 15 minutes')

  await new Promise<void>((resolve) => server.listen(PORT, resolve))
  console.log(`[worker] listening on :${PORT}`)
  console.log('[worker] ready')
}

/**
 * Graceful shutdown. Docker sends SIGTERM and waits 10s before SIGKILL; a job
 * killed mid-write leaves a partially indexed library, so stop accepting work
 * and drain first.
 */
let shuttingDown = false
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[worker] ${signal} received, shutting down`)

  const timer = setTimeout(() => {
    console.error('[worker] drain timed out, exiting anyway')
    process.exit(1)
  }, 40_000)
  timer.unref()

  try {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await queue.stop()
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
