import { watch, type FSWatcher } from 'chokidar'
import { getDb, schema } from '@pb/db'
import { isIgnoredPath } from '@pb/core'
import { JOB, getQueue } from '@pb/jobs'

/**
 * Live filesystem watching, per library, on top of the scan schedule.
 *
 * Off by default and opt-in per library — see the note on `watchEnabled` in
 * packages/db/src/schema/libraries.ts. Chokidar itself is the well-tested
 * part; what belongs to this app is keeping the set of active watchers in
 * step with what the database says should be watched, which changes
 * underneath this process whenever someone flips the toggle in the UI or
 * deletes a library.
 *
 * A watch event enqueues a fast scan, debounced, rather than updating the
 * index itself — reusing the same scan pipeline a schedule or the Scan button
 * already runs, rather than a second implementation of "what changed" that
 * could disagree with the first.
 */

const RECONCILE_INTERVAL_MS = 60_000
const DEBOUNCE_MS = 5_000

interface Watched {
  watcher: FSWatcher
  path: string
  timer?: ReturnType<typeof setTimeout>
}

const active = new Map<string, Watched>()

interface WatchTarget {
  id: string
  name: string
  path: string
}

/** Which libraries the database currently wants watched. Pure — no side effects. */
export async function watchTargets(): Promise<WatchTarget[]> {
  const rows = await getDb()
    .select({
      id: schema.libraries.id,
      name: schema.libraries.name,
      path: schema.libraries.path,
      backend: schema.libraries.backend,
      watchEnabled: schema.libraries.watchEnabled,
    })
    .from(schema.libraries)

  // Local backend only: S3 has no filesystem for chokidar to watch, and
  // scanning it is already the only mechanism, same as before this existed.
  return rows
    .filter((row) => row.watchEnabled && row.backend === 'local' && row.path)
    .map((row) => ({ id: row.id, name: row.name, path: row.path! }))
}

/** Starts and stops watchers so the active set matches `watchTargets()`. */
export async function reconcileWatches(): Promise<void> {
  const wanted = new Map(
    (await watchTargets()).map((target) => [target.id, target] as const),
  )

  for (const [libraryId, watched] of active) {
    const target = wanted.get(libraryId)
    // Turned off, deleted, or repointed at a different folder.
    if (!target || target.path !== watched.path) {
      await stopWatch(libraryId)
    }
  }

  for (const [libraryId, target] of wanted) {
    if (!active.has(libraryId)) startWatch(libraryId, target.name, target.path)
  }
}

function startWatch(libraryId: string, name: string, root: string): void {
  const watcher = watch(root, {
    ignoreInitial: true,
    ignored: (candidate: string) => isIgnoredPath(candidate.replace(/\\/g, '/')),
    // Waits for a write to actually finish before firing — otherwise a
    // multi-gigabyte copy in progress triggers a scan on every chunk.
    awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 500 },
  })

  const entry: Watched = { watcher, path: root }
  active.set(libraryId, entry)

  const queueScan = () => {
    /*
     * Debounced per library. A folder drop touches dozens of files in
     * milliseconds, and without this each one would queue its own scan —
     * `stately` on library.scan collapses those anyway, but there is no
     * reason to ask fifty times for the same thing.
     */
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = setTimeout(() => {
      getQueue()
        .send(
          JOB.libraryScan,
          { libraryId, mode: 'fast', force: false },
          { singletonKey: `scan:${libraryId}` },
        )
        .catch((error: unknown) => {
          console.warn(`[watch] could not queue a scan of "${name}": ${String(error)}`)
        })
    }, DEBOUNCE_MS)
  }

  watcher.on('all', queueScan)
  watcher.on('error', (error) => console.warn(`[watch] "${name}": ${String(error)}`))

  console.log(`[watch] watching "${name}" at ${root}`)
}

async function stopWatch(libraryId: string): Promise<void> {
  const entry = active.get(libraryId)
  if (!entry) return
  if (entry.timer) clearTimeout(entry.timer)
  active.delete(libraryId)
  await entry.watcher.close()
}

/** How many libraries are currently being watched. For the worker's own logs. */
export function activeWatchCount(): number {
  return active.size
}

/**
 * Starts the reconciler, returning a stop function for graceful shutdown.
 *
 * A sweep rather than reacting to library changes directly, matching the
 * scan-schedule sweep in jobs/schedule.ts: a toggle flipped in the UI takes
 * effect within a minute with nothing to re-register, and the worker
 * recovers cleanly if it was restarted with libraries already wanting to be
 * watched.
 */
export function startWatchReconciler(): () => Promise<void> {
  void reconcileWatches().catch((error: unknown) => {
    console.warn(`[watch] initial reconcile failed: ${String(error)}`)
  })

  const interval = setInterval(() => {
    void reconcileWatches().catch((error: unknown) => {
      console.warn(`[watch] reconcile failed: ${String(error)}`)
    })
  }, RECONCILE_INTERVAL_MS)

  return async () => {
    clearInterval(interval)
    await Promise.all([...active.keys()].map(stopWatch))
  }
}
