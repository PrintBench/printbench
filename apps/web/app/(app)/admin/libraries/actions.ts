'use server'

import { eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { LocalAdapter, groupModels, slugify, walkLibrary, type LibraryLocation } from '@pm/core'
import { assertCan, cronProblem, PolicyError } from '@pm/core'
import { requireUser } from '@pm/auth'
import { getDb, schema } from '@pm/db'
import { getStartedQueue, JOB } from '@pm/jobs'

type Result<T = undefined> = { ok: true; data?: T } | { ok: false; error: string }

async function assertAdmin() {
  const user = await requireUser()
  assertCan({ id: user.id, role: user.role ?? null, banned: user.banned ?? false }, 'library:manage')
  return user
}

export interface PreviewSample {
  path: string
  name: string
  fileCount: number
  isFileModel: boolean
}

export interface PreviewResult {
  ok: boolean
  error?: string
  modelCount: number
  containerCount: number
  fileCount: number
  samples: PreviewSample[]
  warnings: string[]
}

/**
 * Dry run: shows what a scan WOULD find, without writing anything.
 *
 * This exists because the folder-to-model heuristic is the riskiest logic in
 * the app. Seeing "we found 412 models, here are 20 of them" before the first
 * real scan is what stops a mis-detection turning a library into thousands of
 * junk rows.
 */
export async function previewLibrary(input: {
  path: string
  groupingMode?: 'deepest' | 'top_level' | 'flat'
  groupingDepth?: number
  /** A managed library is allowed to start empty. */
  allowEmpty?: boolean
}): Promise<PreviewResult> {
  const empty: PreviewResult = {
    ok: false,
    modelCount: 0,
    containerCount: 0,
    fileCount: 0,
    samples: [],
    warnings: [],
  }

  try {
    await assertAdmin()
  } catch {
    return { ...empty, error: 'Not permitted.' }
  }

  const trimmed = input.path.trim()
  if (!trimmed) return { ...empty, error: 'Enter a folder path.' }

  const location: LibraryLocation = {
    id: 'preview',
    kind: 'in_place',
    backend: 'local',
    allowWrites: false,
    path: trimmed,
  }

  try {
    const storage = new LocalAdapter(location)

    const health = await storage.healthCheck()
    if (!health.ok) return { ...empty, error: health.reason ?? 'Folder is not readable.' }
    if ((health.entryCount ?? 0) === 0 && !input.allowEmpty) {
      return { ...empty, error: 'That folder is empty.' }
    }

    // Bounded: a preview must stay responsive even on a huge library.
    const walk = await walkLibrary(storage, { mode: 'deep', maxEntries: 20_000 })
    const grouped = groupModels(walk.tree, {
      mode: input.groupingMode ?? 'deepest',
      depth: input.groupingDepth,
    })

    const warnings: string[] = []
    if (walk.stats.truncated) {
      warnings.push('Only the first 20,000 files were sampled, so the real count will be higher.')
    }
    if (walk.stats.errors.length > 0) {
      warnings.push(`${walk.stats.errors.length} folders could not be read and were skipped.`)
    }
    const nested = grouped.models.filter((m) => m.nestedModelPaths.length > 0)
    if (nested.length > 0) {
      warnings.push(
        `${nested.length} folders contain both their own files and sub-models. ` +
          `They were split; try "Top level" grouping if they should be single models.`,
      )
    }
    if (grouped.models.length === 0) {
      warnings.push('No models were found. Check the path, or try a different grouping mode.')
    }

    return {
      ok: true,
      modelCount: grouped.models.length,
      containerCount: grouped.containers.length,
      fileCount: walk.stats.filesSeen,
      warnings,
      samples: grouped.models.slice(0, 20).map((model) => ({
        path: model.path,
        name: model.name,
        fileCount: model.files.length,
        isFileModel: model.isFileModel,
      })),
    }
  } catch (error) {
    return { ...empty, error: error instanceof Error ? error.message : 'Could not read that folder.' }
  }
}

export async function createLibrary(input: {
  name: string
  path: string
  kind: 'in_place' | 'managed'
  groupingMode: 'deepest' | 'top_level' | 'flat'
  groupingDepth?: number
  writeSidecar: boolean
}): Promise<Result<{ id: string }>> {
  try {
    await assertAdmin()

    const name = input.name.trim()
    const path = input.path.trim()
    if (!name) return { ok: false, error: 'Give the library a name.' }
    if (!path) return { ok: false, error: 'Enter a folder path.' }

    /*
     * A managed library owns its folder, so create it if it is not there yet —
     * asking someone to go and mkdir before they can upload is a pointless
     * step. An in-place library must already exist: being pointed at a typo and
     * silently creating an empty directory is worse than an error.
     */
    if (input.kind === 'managed') {
      const { mkdir } = await import('node:fs/promises')
      await mkdir(path, { recursive: true })
    }

    const storage = new LocalAdapter({
      id: 'validate',
      kind: input.kind,
      backend: 'local',
      allowWrites: false,
      path,
    })
    const health = await storage.healthCheck()
    if (!health.ok) return { ok: false, error: health.reason ?? 'Folder is not readable.' }

    const db = getDb()
    const existing = await db
      .select({ id: schema.libraries.id })
      .from(schema.libraries)
      .where(eq(schema.libraries.path, path))
      .limit(1)
    if (existing[0]) return { ok: false, error: 'A library already points at that folder.' }

    const [created] = await db
      .insert(schema.libraries)
      .values({
        name,
        path,
        kind: input.kind,
        backend: 'local',
        groupingMode: input.groupingMode,
        groupingDepth: input.groupingDepth ?? null,
        writeSidecar: input.writeSidecar,
      })
      .returning({ id: schema.libraries.id })

    revalidatePath('/admin/libraries')
    return { ok: true, data: { id: created!.id } }
  } catch (error) {
    if (error instanceof PolicyError) return { ok: false, error: 'Not permitted.' }
    return { ok: false, error: error instanceof Error ? error.message : 'Could not create the library.' }
  }
}

export async function triggerScan(
  libraryId: string,
  options: { mode?: 'fast' | 'deep'; force?: boolean } = {},
): Promise<Result> {
  try {
    const user = await requireUser()
    assertCan({ id: user.id, role: user.role ?? null, banned: user.banned ?? false }, 'scan:trigger')

    /*
     * getStartedQueue, not getQueue. The web process never boots the queue
     * itself — it only sends — so an unstarted singleton threw here and the
     * catch below reported it as "could not queue the scan".
     *
     * `stately` policy plus this key means repeated presses collapse instead of
     * queueing a scan each time.
     */
    const queue = await getStartedQueue()
    await queue.send(
      JOB.libraryScan,
      { libraryId, mode: options.mode ?? 'fast', force: options.force ?? false },
      { singletonKey: `scan:${libraryId}` },
    )

    revalidatePath('/admin/libraries')
    return { ok: true }
  } catch (error) {
    if (error instanceof PolicyError) return { ok: false, error: 'Not permitted.' }
    // Logged, because swallowing this is how the queue never being started
    // stayed invisible.
    console.error('[scan] could not enqueue:', error)
    return { ok: false, error: 'Could not queue the scan. Check the worker logs.' }
  }
}

/**
 * Changes how and when a library is scanned.
 *
 * The schedule is stored as cron and evaluated by a sweep in the worker, so a
 * change here takes effect at the next sweep with nothing to re-register.
 */
export async function updateLibrarySchedule(
  libraryId: string,
  input: { scanCron: string; scanEnabled: boolean },
): Promise<Result> {
  try {
    await assertAdmin()

    const cron = input.scanCron.trim()
    const problem = cronProblem(cron)
    if (problem) return { ok: false, error: problem }

    await getDb()
      .update(schema.libraries)
      .set({
        // Empty string and NULL both mean "no schedule"; store one of them.
        scanCron: cron === '' ? null : cron,
        scanEnabled: input.scanEnabled,
        updatedAt: new Date(),
      })
      .where(eq(schema.libraries.id, libraryId))

    revalidatePath('/admin/libraries')
    return { ok: true }
  } catch (error) {
    if (error instanceof PolicyError) return { ok: false, error: 'Not permitted.' }
    return { ok: false, error: 'Could not save the schedule.' }
  }
}

export async function deleteLibrary(libraryId: string): Promise<Result> {
  try {
    await assertAdmin()
    // Removes the index only. The user's files are never touched.
    await getDb().delete(schema.libraries).where(eq(schema.libraries.id, libraryId))
    revalidatePath('/admin/libraries')
    return { ok: true }
  } catch (error) {
    if (error instanceof PolicyError) return { ok: false, error: 'Not permitted.' }
    return { ok: false, error: 'Could not remove the library.' }
  }
}

export { slugify }
