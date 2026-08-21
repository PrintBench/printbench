/**
 * Worker process. Runs everything that must not block page rendering:
 * library scanning, geometry analysis, thumbnail rendering, resumable uploads
 * and streaming ZIP downloads.
 *
 * Shares packages/db|core|mesh|jobs with the web app, and imports neither React
 * nor Next. Auth is a web-tier concern and is deliberately absent here.
 */
import { createServer } from 'node:http'
import path from 'node:path'
import { mkdirSync } from 'node:fs'
import { sql } from 'drizzle-orm'
import { loadRootEnv } from '@pb/core'
import { createDb } from '@pb/db'
import { JOB, getQueue } from '@pb/jobs'
import { handleLibraryScan } from './jobs/scan'
import { handleFileAnalyze, handleFileDigest, handleFileThumbnail } from './jobs/analyze'
import { handleHealthDetect } from './jobs/health'
import { handleMaintArchive, handleMaintReconcile } from './jobs/maintenance'
import { handleScheduleSweep } from './jobs/schedule'
import { handleZipRequest } from './http/zip'
import { handleUploadRequest } from './http/upload'
import { activeWatchCount, startWatchReconciler } from './watch/watcher'

// Must run before anything reads DATABASE_URL.
loadRootEnv()

const PORT = Number(process.env.WORKER_PORT ?? 3001)

/*
 * Uploads land here first and move into the library only once complete, so a
 * scan never sees a half-written mesh.
 */
const STAGING_DIR = path.resolve(process.env.DATA_DIR ?? './data', 'uploads')
mkdirSync(STAGING_DIR, { recursive: true })

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
  // Named pathname, not path: `path` is the node module imported above.
  const pathname = (req.url ?? '').split('?')[0] ?? ''

  if (pathname === '/api/upload/health' || pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok', role: 'worker' }))
    return
  }

  /*
   * Whole-model ZIPs are built here rather than in the web process: an 8 GB
   * archive occupies a thread for minutes, and doing that in the page-rendering
   * process makes the UI stutter for everyone.
   */
  if (pathname === '/api/download/model') {
    handleZipRequest(req, res).catch((error) => {
      console.error('[zip] unhandled failure:', error)
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'text/plain' })
        res.end('Download failed')
      } else {
        res.destroy()
      }
    })
    return
  }

  // Resumable uploads. tus owns everything under this prefix, including the
  // per-upload URLs it hands back.
  if (pathname.startsWith('/api/upload')) {
    handleUploadRequest(req, res, STAGING_DIR)
    return
  }

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
  await queue.work(JOB.healthDetect, handleHealthDetect)
  await queue.work(JOB.maintReconcile, handleMaintReconcile)
  await queue.work(JOB.maintArchive, handleMaintArchive)
  await queue.work(JOB.scheduleSweep, handleScheduleSweep)
  console.log(
    '[worker] handlers: library.scan, file.analyze, file.thumbnail, file.digest, ' +
      'health.detect, library.schedule, maint.reconcile, maint.archive',
  )

  /*
   * Re-enqueues derived work that was lost — a worker killed mid-render leaves
   * a file pending forever otherwise, and the symptom is a thumbnail that
   * simply never appears.
   */
  await queue.schedule(JOB.maintReconcile, '*/15 * * * *', {})
  console.log('[worker] scheduled: maintenance sweep every 15 minutes')

  /*
   * Per-library scan schedules are evaluated here rather than registered with
   * pg-boss, which keeps only one schedule per queue name. Every five minutes
   * is fine granularity for a schedule measured in hours, and means a change
   * made in the UI takes effect almost at once.
   */
  await queue.schedule(JOB.scheduleSweep, '*/5 * * * *', {})
  console.log('[worker] scheduled: library schedule sweep every 5 minutes')

  /*
   * A nightly health pass, so problems that appear without a scan — a digest
   * finishing and revealing a duplicate, metadata edited away — are still
   * found. 03:20 rather than exactly 03:00: every self-hosted cron in the
   * world fires on the hour.
   */
  await queue.schedule(JOB.healthDetect, '20 3 * * *', { skipCosmetic: false })
  console.log('[worker] scheduled: library health nightly at 03:20')

  /*
   * The archive sweep, which is the only scheduled job that deletes anything.
   * Deliberately after the health pass: if health has just found every model in
   * a library missing, that is exactly the case prune() refuses to act on.
   */
  await queue.schedule(JOB.maintArchive, '45 3 * * *', {})
  console.log('[worker] scheduled: archive sweep nightly at 03:45')

  /*
   * Optional, per-library, off by default. Reconciled on the same "sweep and
   * compare to the database" pattern as the scan schedule above, rather than
   * reacting to library changes directly — see watch/watcher.ts.
   */
  stopWatching = startWatchReconciler()
  console.log('[worker] watch reconciler started, sweeping every 60s')

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
let stopWatching: (() => Promise<void>) | undefined
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
    console.log(`[worker] closing ${activeWatchCount()} filesystem watcher(s)`)
    await stopWatching?.()
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
