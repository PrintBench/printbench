'use server'

import { and, eq, isNull } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import {
  LocalAdapter,
  RootError,
  browseDirectories,
  createStorageAdapter,
  encryptSecret,
  groupModels,
  libraryRoots,
  managedRoot,
  slugify,
  validateLibraryPath,
  walkLibrary,
  type BrowseResult,
  type LibraryLocation,
} from '@pm/core'
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

type BrowseResponse = { ok: true; result: BrowseResult } | { ok: false; error: string }

/**
 * Lists the folders an admin may choose from.
 *
 * The whole point of the picker: nobody should have to know what path their
 * files have inside a container. The server knows what is mounted, so it
 * offers that instead of asking.
 */
export async function browseFolders(target?: string | null): Promise<BrowseResponse> {
  try {
    await assertAdmin()
    return { ok: true, result: await browseDirectories(target) }
  } catch (error) {
    if (error instanceof RootError) return { ok: false, error: error.message }
    if (error instanceof PolicyError) return { ok: false, error: 'Not permitted.' }
    console.error('[libraries] browse failed:', error)
    return { ok: false, error: 'Could not read that folder.' }
  }
}

/** Where managed libraries are created, so the form can say so plainly. */
export async function uploadLocation(): Promise<{ root: string; browsable: string[] }> {
  try {
    await assertAdmin()
    return { root: managedRoot(), browsable: libraryRoots() }
  } catch {
    return { root: '', browsable: [] }
  }
}

export interface S3Config {
  bucket: string
  prefix?: string
  region?: string
  endpoint?: string
  accessKeyId?: string
  secretAccessKey?: string
  forcePathStyle?: boolean
}

/** Builds the location the storage layer needs from the form's S3 fields. */
function s3Location(id: string, kind: 'in_place' | 'managed', s3: S3Config): LibraryLocation {
  return {
    id,
    kind,
    backend: 's3',
    allowWrites: kind === 'managed',
    s3Bucket: s3.bucket,
    s3Prefix: s3.prefix || null,
    s3Region: s3.region || null,
    s3Endpoint: s3.endpoint || null,
    s3AccessKeyId: s3.accessKeyId || null,
    s3SecretAccessKey: s3.secretAccessKey || null,
    s3ForcePathStyle: s3.forcePathStyle ?? Boolean(s3.endpoint),
  }
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
  /** Local backend. Either this or `s3` is required. */
  path?: string
  /** S3 backend. */
  s3?: S3Config
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

  let location: LibraryLocation

  if (input.s3) {
    if (!input.s3.bucket.trim()) return { ...empty, error: 'Give the bucket a name.' }
    location = s3Location('preview', 'in_place', input.s3)
  } else {
    /*
     * Validated against the roots for the same reason createLibrary is: this
     * walks a directory and reports its contents, so an unchecked path here
     * would be a way to enumerate the host.
     */
    const validated = await validateLibraryPath(input.path ?? '')
    if (!validated.ok) return { ...empty, error: validated.error }
    location = { id: 'preview', kind: 'in_place', backend: 'local', allowWrites: false, path: validated.path }
  }

  try {
    const storage = createStorageAdapter(location)

    const health = await storage.healthCheck()
    if (!health.ok) return { ...empty, error: health.reason ?? 'That location is not readable.' }
    if ((health.entryCount ?? 0) === 0 && !input.allowEmpty) {
      return { ...empty, error: 'That location is empty.' }
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
  /** Required for an existing folder; ignored for an uploads library or S3. */
  path?: string
  /** An existing S3 bucket. Only offered for `in_place` — see the form. */
  s3?: S3Config
  kind: 'in_place' | 'managed'
  groupingMode: 'deepest' | 'top_level' | 'flat'
  groupingDepth?: number
  writeSidecar: boolean
}): Promise<Result<{ id: string }>> {
  try {
    await assertAdmin()

    const name = input.name.trim()
    if (!name) return { ok: false, error: 'Give the library a name.' }

    if (input.s3) {
      /*
       * Not offered by the form, but checked here too: an uploads library
       * writing into someone's existing bucket is a very different, much
       * larger feature (multipart writes through the tus pipeline) than
       * reading one that already has files in it.
       */
      if (input.kind === 'managed') {
        return { ok: false, error: 'An uploads library cannot be backed by S3 yet.' }
      }
      if (!input.s3.bucket.trim()) return { ok: false, error: 'Give the bucket a name.' }

      const storage = createStorageAdapter(s3Location('validate', 'in_place', input.s3))
      const health = await storage.healthCheck()
      if (!health.ok) return { ok: false, error: health.reason ?? 'That bucket is not readable.' }

      const db = getDb()
      const prefix = input.s3.prefix?.trim() || null
      const existing = await db
        .select({ id: schema.libraries.id })
        .from(schema.libraries)
        .where(
          and(
            eq(schema.libraries.backend, 's3'),
            eq(schema.libraries.s3Bucket, input.s3.bucket.trim()),
            prefix ? eq(schema.libraries.s3Prefix, prefix) : isNull(schema.libraries.s3Prefix),
          ),
        )
        .limit(1)
      if (existing[0]) return { ok: false, error: 'A library already points at that bucket.' }

      const [created] = await db
        .insert(schema.libraries)
        .values({
          name,
          kind: 'in_place',
          backend: 's3',
          allowWrites: false,
          s3Bucket: input.s3.bucket.trim(),
          s3Prefix: prefix,
          s3Region: input.s3.region?.trim() || null,
          s3Endpoint: input.s3.endpoint?.trim() || null,
          s3AccessKeyId: input.s3.accessKeyId?.trim() || null,
          // Encrypted at rest, like every other stored credential — see printers.
          s3SecretAccessKey: input.s3.secretAccessKey ? encryptSecret(input.s3.secretAccessKey) : null,
          s3ForcePathStyle: input.s3.forcePathStyle ?? Boolean(input.s3.endpoint),
          groupingMode: input.groupingMode,
          groupingDepth: input.groupingDepth ?? null,
          writeSidecar: input.writeSidecar,
        })
        .returning({ id: schema.libraries.id })

      revalidatePath('/admin/libraries')
      return { ok: true, data: { id: created!.id } }
    }

    let path: string

    if (input.kind === 'managed') {
      /*
       * An uploads library owns its folder, so the admin never picks a path —
       * one is derived from the name under the writable root and created here.
       * Asking someone to choose a directory for files they have not uploaded
       * yet is a question with no useful answer.
       */
      const { join } = await import('node:path')
      const { mkdir } = await import('node:fs/promises')

      path = join(managedRoot(), slugify(name) || 'library')
      await mkdir(path, { recursive: true })
    } else {
      /*
       * An existing folder must already be there. Being pointed at a typo and
       * silently creating an empty directory is worse than an error, and the
       * roots check keeps this from becoming a way to index /etc.
       */
      const validated = await validateLibraryPath(input.path ?? '')
      if (!validated.ok) return { ok: false, error: validated.error }
      path = validated.path
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
        // An uploads library exists to be written to; the read-only promise
        // applies to folders the user already had.
        allowWrites: input.kind === 'managed',
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

    const updated = await getDb()
      .update(schema.libraries)
      .set({
        // Empty string and NULL both mean "no schedule"; store one of them.
        scanCron: cron === '' ? null : cron,
        scanEnabled: input.scanEnabled,
        updatedAt: new Date(),
      })
      .where(eq(schema.libraries.id, libraryId))

    // Matching no rows is not success; saying otherwise reports a saved
    // schedule that was not saved.
    if (updated.rowCount === 0) return { ok: false, error: 'That library no longer exists.' }

    revalidatePath('/admin/libraries')
    return { ok: true }
  } catch (error) {
    if (error instanceof PolicyError) return { ok: false, error: 'Not permitted.' }
    return { ok: false, error: 'Could not save the schedule.' }
  }
}

/**
 * Turns live filesystem watching on or off for one library.
 *
 * Takes effect within a minute: the worker reconciles its active watchers
 * against the database on a sweep (apps/worker/src/watch/watcher.ts) rather
 * than this action reaching into the worker process directly — the two
 * processes share nothing but the database, on purpose.
 */
export async function updateLibraryWatch(libraryId: string, watchEnabled: boolean): Promise<Result> {
  try {
    await assertAdmin()

    const updated = await getDb()
      .update(schema.libraries)
      .set({ watchEnabled, updatedAt: new Date() })
      .where(eq(schema.libraries.id, libraryId))

    if (updated.rowCount === 0) return { ok: false, error: 'That library no longer exists.' }

    revalidatePath('/admin/libraries')
    return { ok: true }
  } catch (error) {
    if (error instanceof PolicyError) return { ok: false, error: 'Not permitted.' }
    return { ok: false, error: 'Could not change watching for that library.' }
  }
}

export async function deleteLibrary(libraryId: string): Promise<Result> {
  try {
    await assertAdmin()
    // Removes the index only. The user's files are never touched.
    const removed = await getDb()
      .delete(schema.libraries)
      .where(eq(schema.libraries.id, libraryId))

    if (removed.rowCount === 0) return { ok: false, error: 'That library no longer exists.' }

    revalidatePath('/admin/libraries')
    return { ok: true }
  } catch (error) {
    if (error instanceof PolicyError) return { ok: false, error: 'Not permitted.' }
    return { ok: false, error: 'Could not remove the library.' }
  }
}

export { slugify }
