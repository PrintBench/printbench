/**
 * The scan pipeline.
 *
 * Walks a library, works out which directories are models, and reconciles that
 * against the database. Everything here is idempotent: rescanning an unchanged
 * library must produce no writes and no duplicates.
 *
 * The safety guards are the most important part of this file. A scan is the one
 * operation that can destroy metadata the user spent hours creating, and the
 * usual cause is not a bug in the diff — it is a NAS that quietly unmounted, so
 * the library looks empty and every model appears deleted.
 */

import { and, eq, isNull, lt, sql } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { excludedPaths } from '../services/delete-service'
import type { Database } from '@pm/db'
import { schema } from '@pm/db'
import { groupModels, looksPresupported, pickPreviewFile, type GroupedModel } from '../library/grouping'
import { walkLibrary, type DirFingerprint } from '../library/walker'
import { lookup } from '../library/media-types'
import { basename, slugify } from '../library/paths'
import { refreshModelSearchVectors } from '../search/refresh'
import { readSidecar } from '../sidecar/sidecar'
import type { LibraryLocation, StorageAdapter } from '../storage/types'

/**
 * Refuse to proceed if a scan would mark more than this share of a library's
 * models missing. An unmounted volume is far more likely than a user deleting
 * a third of their collection between two scans.
 */
export const MASS_DISAPPEARANCE_THRESHOLD = 0.2

/** Below this, proportional checks are meaningless. */
const MIN_MODELS_FOR_THRESHOLD = 5

export type AbortReason =
  | 'storage_unavailable'
  | 'empty_root'
  | 'mass_disappearance'

export interface ScanOptions {
  mode?: 'fast' | 'deep'
  /** Set by an admin to confirm a genuine mass deletion. */
  force?: boolean
  signal?: AbortSignal
  onProgress?: (progress: ScanProgress) => void
  /**
   * Called with the ids of files needing analysis, a thumbnail or a digest.
   *
   * A callback rather than a direct enqueue so this package stays free of any
   * dependency on the job queue — it can then be tested without one, and the
   * worker decides how the work is dispatched.
   */
  onDerivedWork?: (fileIds: string[]) => Promise<void> | void
}

export interface ScanProgress {
  phase: 'walking' | 'grouping' | 'reconciling' | 'pruning' | 'done'
  dirsWalked?: number
  filesSeen?: number
  modelsSeen?: number
}

export interface ScanOutcome {
  scanRunId: string
  status: 'succeeded' | 'aborted' | 'failed'
  abortReason?: AbortReason
  abortDetail?: string
  dirsWalked: number
  filesSeen: number
  modelsCreated: number
  /** Folders skipped because the user removed the model. */
  modelsExcluded: number
  modelsUpdated: number
  modelsMissing: number
  filesCreated: number
  filesMissing: number
  renamesDetected: number
  /** Files handed to the derived-work queue. */
  filesQueued: number
  /** Models whose metadata was restored from an on-disk sidecar. */
  sidecarsRestored: number
  errors: { path: string; reason: string }[]
}

export interface ScanDeps {
  db: Database
  storage: StorageAdapter
  library: LibraryLocation
}

export async function scanLibrary(
  { db, storage, library }: ScanDeps,
  options: ScanOptions = {},
): Promise<ScanOutcome> {
  const mode = options.mode ?? 'deep'
  const startedAt = new Date()

  const [run] = await db
    .insert(schema.scanRuns)
    .values({ libraryId: library.id, status: 'running', mode, startedAt })
    .returning({ id: schema.scanRuns.id })

  const scanRunId = run!.id
  const outcome: ScanOutcome = {
    scanRunId,
    status: 'succeeded',
    dirsWalked: 0,
    filesSeen: 0,
    modelsCreated: 0,
    modelsExcluded: 0,
    modelsUpdated: 0,
    modelsMissing: 0,
    filesCreated: 0,
    filesMissing: 0,
    renamesDetected: 0,
    filesQueued: 0,
    sidecarsRestored: 0,
    errors: [],
  }

  const abort = async (reason: AbortReason, detail: string): Promise<ScanOutcome> => {
    outcome.status = 'aborted'
    outcome.abortReason = reason
    outcome.abortDetail = detail
    await db
      .update(schema.scanRuns)
      .set({
        status: 'aborted',
        abortReason: reason,
        finishedAt: new Date(),
        errors: [{ reason: detail }],
      })
      .where(eq(schema.scanRuns.id, scanRunId))
    return outcome
  }

  try {
    // ---- Guard 1: is the storage even there? ------------------------------
    const health = await storage.healthCheck()
    if (!health.ok) {
      return await abort('storage_unavailable', health.reason ?? 'Storage is unreachable')
    }

    const knownModelCount = await countLiveModels(db, library.id)

    // ---- Guard 2: empty root with models on record ------------------------
    // The classic unmounted-NAS signature.
    if ((health.entryCount ?? 0) === 0 && knownModelCount > 0 && !options.force) {
      return await abort(
        'empty_root',
        `The library folder is empty but ${knownModelCount} models are on record. ` +
          `This usually means the drive or network share is not mounted.`,
      )
    }

    // ---- Walk --------------------------------------------------------------
    options.onProgress?.({ phase: 'walking' })
    const known = await loadFingerprints(db, library.id)
    const walk = await walkLibrary(storage, { mode, known, signal: options.signal })

    outcome.dirsWalked = walk.stats.dirsWalked
    outcome.filesSeen = walk.stats.filesSeen
    outcome.errors = walk.stats.errors

    options.onProgress?.({
      phase: 'grouping',
      dirsWalked: walk.stats.dirsWalked,
      filesSeen: walk.stats.filesSeen,
    })

    const grouped = groupModels(walk.tree, {
      mode: (library as { groupingMode?: 'deepest' | 'top_level' | 'flat' }).groupingMode ?? 'deepest',
    })

    // ---- Guard 3: mass disappearance --------------------------------------
    const seenPaths = new Set(grouped.models.map((m) => m.path))
    const wouldGoMissing = await countModelsNotIn(db, library.id, seenPaths)

    if (
      !options.force &&
      knownModelCount >= MIN_MODELS_FOR_THRESHOLD &&
      wouldGoMissing / knownModelCount > MASS_DISAPPEARANCE_THRESHOLD
    ) {
      const percent = Math.round((wouldGoMissing / knownModelCount) * 100)
      return await abort(
        'mass_disappearance',
        `This scan would mark ${wouldGoMissing} of ${knownModelCount} models (${percent}%) as missing. ` +
          `Refusing to proceed in case the storage is only partly available. ` +
          `An admin can confirm this was a genuine deletion.`,
      )
    }

    // ---- Reconcile ---------------------------------------------------------
    options.onProgress?.({ phase: 'reconciling', modelsSeen: grouped.models.length })

    /*
     * Models the user has removed. Their folders are still on disk, so without
     * this the scan finds them and recreates them — which looks exactly like
     * the delete button not having worked.
     */
    const excluded = await excludedPaths(db, library.id)
    if (excluded.size > 0) {
      outcome.modelsExcluded = grouped.models.filter((model) => excluded.has(model.path)).length
    }

    const touchedModelIds: string[] = []
    for (const model of grouped.models) {
      if (excluded.has(model.path)) continue

      const result = await upsertModel(db, library.id, model, startedAt)
      touchedModelIds.push(result.modelId)
      if (result.created) {
        outcome.modelsCreated++
        /*
         * Restore metadata from the sidecar, but only for a model being seen
         * for the first time.
         *
         * This is what makes the database rebuildable: drop Postgres, rescan,
         * and tags, creator, licence and notes come back. Applying it on every
         * scan instead would let a stale file on disk overwrite an edit made in
         * the app — the database is authoritative once a model is known.
         */
        if (!model.isFileModel) {
          const restored = await restoreFromSidecar(db, storage, result.modelId, model.path)
          if (restored) outcome.sidecarsRestored++
        }
      } else {
        outcome.modelsUpdated++
      }
      outcome.filesCreated += result.filesCreated
      outcome.renamesDetected += result.renamesDetected
    }

    // ---- Prune -------------------------------------------------------------
    options.onProgress?.({ phase: 'pruning' })
    const pruned = await markMissing(db, library.id, startedAt)
    outcome.modelsMissing = pruned.models
    outcome.filesMissing = pruned.files

    await saveFingerprints(db, library.id, walk.fingerprints, startedAt)

    /*
     * Hand off files whose derived data is missing or stale. Queried rather
     * than tracked during the walk, so a file left pending by an earlier
     * interrupted scan is picked up too.
     */
    if (options.onDerivedWork) {
      const pending = await db.execute<{ id: string }>(sql`
        SELECT f.id FROM model_files f
        JOIN models m ON m.id = f.model_id
        WHERE m.library_id = ${library.id}
          AND f.missing_at IS NULL
          AND f.previewable = true
          AND (f.analysis_state = 'pending' OR f.thumb_state = 'pending' OR f.digest IS NULL)
        LIMIT 50000
      `)
      const ids = pending.rows.map((row) => row.id)
      outcome.filesQueued = ids.length
      if (ids.length > 0) await options.onDerivedWork(ids)
    }

    // Search vectors last, in batches, so the models are immediately findable.
    for (let i = 0; i < touchedModelIds.length; i += 500) {
      await refreshModelSearchVectors(db, touchedModelIds.slice(i, i + 500))
    }

    await db
      .update(schema.scanRuns)
      .set({
        status: 'succeeded',
        finishedAt: new Date(),
        dirsWalked: outcome.dirsWalked,
        filesSeen: outcome.filesSeen,
        modelsCreated: outcome.modelsCreated,
        modelsUpdated: outcome.modelsUpdated,
        modelsMissing: outcome.modelsMissing,
        filesQueued: outcome.filesQueued,
        errors: outcome.errors.length > 0 ? outcome.errors : null,
      })
      .where(eq(schema.scanRuns.id, scanRunId))

    await db
      .update(schema.libraries)
      .set({ lastScanId: scanRunId, updatedAt: new Date() })
      .where(eq(schema.libraries.id, library.id))

    options.onProgress?.({ phase: 'done' })
    return outcome
  } catch (error) {
    outcome.status = 'failed'
    const message = error instanceof Error ? error.message : String(error)
    await db
      .update(schema.scanRuns)
      .set({ status: 'failed', finishedAt: new Date(), errors: [{ reason: message }] })
      .where(eq(schema.scanRuns.id, scanRunId))
    throw error
  }
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

interface UpsertResult {
  modelId: string
  created: boolean
  filesCreated: number
  renamesDetected: number
}

async function upsertModel(
  db: Database,
  libraryId: string,
  model: GroupedModel,
  seenAt: Date,
): Promise<UpsertResult> {
  const existing = await db
    .select({ id: schema.models.id, name: schema.models.name })
    .from(schema.models)
    .where(and(eq(schema.models.libraryId, libraryId), eq(schema.models.path, model.path)))
    .limit(1)

  let modelId: string
  let created = false

  if (existing[0]) {
    modelId = existing[0].id
    // Only touch bookkeeping columns: the user may have renamed this model or
    // written notes, and a rescan must never overwrite their edits.
    await db
      .update(schema.models)
      .set({ lastSeenAt: seenAt, missingAt: null, isFileModel: model.isFileModel })
      .where(eq(schema.models.id, modelId))
  } else {
    const inserted = await db
      .insert(schema.models)
      .values({
        libraryId,
        path: model.path,
        name: model.name,
        slug: slugify(model.name) || 'model',
        publicId: nanoid(12),
        isFileModel: model.isFileModel,
        lastSeenAt: seenAt,
      })
      .returning({ id: schema.models.id })
    modelId = inserted[0]!.id
    created = true
  }

  const { filesCreated, renamesDetected } = await upsertFiles(db, modelId, model, seenAt)
  await updateModelRollups(db, modelId, model)

  return { modelId, created, filesCreated, renamesDetected }
}

async function upsertFiles(
  db: Database,
  modelId: string,
  model: GroupedModel,
  seenAt: Date,
): Promise<{ filesCreated: number; renamesDetected: number }> {
  const prefix = model.isFileModel ? '' : `${model.path}/`
  let filesCreated = 0
  const renamesDetected = 0

  const existing = await db
    .select({
      id: schema.modelFiles.id,
      filename: schema.modelFiles.filename,
      size: schema.modelFiles.size,
      digest: schema.modelFiles.digest,
      mtimeMs: schema.modelFiles.mtimeMs,
    })
    .from(schema.modelFiles)
    .where(eq(schema.modelFiles.modelId, modelId))

  const byFilename = new Map(existing.map((row) => [row.filename, row]))

  for (const file of model.files) {
    const filename = model.isFileModel
      ? basename(file.path)
      : file.path.startsWith(prefix)
        ? file.path.slice(prefix.length)
        : basename(file.path)

    const info = lookup(filename)
    const row = byFilename.get(filename)

    if (row) {
      /*
       * Refresh size and mtime as well as the seen marker. A changed
       * (size, mtime) pair is what tells the digest and analysis steps that a
       * file's contents actually need re-examining, so it must stay current.
       */
      const changed = row.size !== file.size || row.mtimeMs !== file.mtimeMs
      await db
        .update(schema.modelFiles)
        .set({
          lastSeenAt: seenAt,
          missingAt: null,
          size: file.size,
          mtimeMs: file.mtimeMs,
          // Contents changed, so anything derived from them is now stale.
          ...(changed ? { digest: null, analysisState: 'pending' as const, thumbState: 'pending' as const } : {}),
        })
        .where(eq(schema.modelFiles.id, row.id))
      byFilename.delete(filename)
      continue
    }

    await db.insert(schema.modelFiles).values({
      modelId,
      filename,
      extension: extensionFrom(filename),
      mediaType: info.mediaType,
      category: info.category,
      previewable: info.previewable ?? false,
      presupported: looksPresupported(file.path),
      size: file.size,
      mtimeMs: file.mtimeMs,
      lastSeenAt: seenAt,
    })
    filesCreated++
  }

  /*
   * Rename detection is deliberately NOT done here yet.
   *
   * Matching a vanished file against a newly-appeared one needs a content
   * digest, and digests are computed by the file.digest job in phase 3. Doing
   * it on (size, mtime) alone would mis-pair the many identically-sized files
   * a print library contains, silently transplanting one file's tags and
   * thumbnail onto another — worse than not doing it at all.
   *
   * Until then a rename shows up as one file missing and one added. The missing
   * row is soft-deleted with a 30-day grace period, so nothing is lost in the
   * meantime.
   */
  return { filesCreated, renamesDetected }
}

function extensionFrom(filename: string): string {
  const dot = filename.lastIndexOf('.')
  return dot > 0 ? filename.slice(dot + 1).toLowerCase() : ''
}

/** Denormalised counts and the preview pick, both used by the grid. */
async function updateModelRollups(db: Database, modelId: string, model: GroupedModel): Promise<void> {
  const files = await db
    .select({
      id: schema.modelFiles.id,
      filename: schema.modelFiles.filename,
      size: schema.modelFiles.size,
      category: schema.modelFiles.category,
      previewable: schema.modelFiles.previewable,
    })
    .from(schema.modelFiles)
    .where(and(eq(schema.modelFiles.modelId, modelId), isNull(schema.modelFiles.missingAt)))

  const totalSize = files.reduce((sum, file) => sum + (file.size ?? 0), 0)

  const previewPath = pickPreviewFile(
    files.map((file) => ({
      path: file.filename,
      size: file.size ?? 0,
      category: file.category,
      previewable: file.previewable,
    })),
    model.name,
  )
  const previewFileId = previewPath
    ? (files.find((file) => file.filename === previewPath)?.id ?? null)
    : null

  await db
    .update(schema.models)
    .set({ fileCount: files.length, totalSize, previewFileId, updatedAt: new Date() })
    .where(eq(schema.models.id, modelId))
}

// ---------------------------------------------------------------------------
// Pruning — soft delete only
// ---------------------------------------------------------------------------

async function markMissing(
  db: Database,
  libraryId: string,
  scanStartedAt: Date,
): Promise<{ models: number; files: number }> {
  const files = await db.execute<{ n: number }>(sql`
    WITH updated AS (
      UPDATE model_files SET missing_at = now()
      WHERE model_id IN (SELECT id FROM models WHERE library_id = ${libraryId})
        AND last_seen_at < ${scanStartedAt.toISOString()}
        AND missing_at IS NULL
      RETURNING 1
    )
    SELECT count(*)::int AS n FROM updated
  `)

  const models = await db.execute<{ n: number }>(sql`
    WITH updated AS (
      UPDATE models SET missing_at = now()
      WHERE library_id = ${libraryId}
        AND last_seen_at < ${scanStartedAt.toISOString()}
        AND missing_at IS NULL
      RETURNING 1
    )
    SELECT count(*)::int AS n FROM updated
  `)

  return { models: models.rows[0]?.n ?? 0, files: files.rows[0]?.n ?? 0 }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function countLiveModels(db: Database, libraryId: string): Promise<number> {
  const result = await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM models
    WHERE library_id = ${libraryId} AND missing_at IS NULL
  `)
  return result.rows[0]?.n ?? 0
}

/** How many live models are NOT among the paths this scan found. */
async function countModelsNotIn(
  db: Database,
  libraryId: string,
  seenPaths: Set<string>,
): Promise<number> {
  const live = await db
    .select({ path: schema.models.path })
    .from(schema.models)
    .where(and(eq(schema.models.libraryId, libraryId), isNull(schema.models.missingAt)))

  return live.filter((row) => !seenPaths.has(row.path)).length
}

async function loadFingerprints(
  db: Database,
  libraryId: string,
): Promise<Map<string, DirFingerprint>> {
  const rows = await db
    .select({
      relPath: schema.libraryDirs.relPath,
      mtimeMs: schema.libraryDirs.mtimeMs,
      entryCount: schema.libraryDirs.entryCount,
    })
    .from(schema.libraryDirs)
    .where(eq(schema.libraryDirs.libraryId, libraryId))

  return new Map(
    rows.map((row) => [row.relPath, { mtimeMs: row.mtimeMs, entryCount: row.entryCount }]),
  )
}

async function saveFingerprints(
  db: Database,
  libraryId: string,
  fingerprints: Map<string, DirFingerprint>,
  seenAt: Date,
): Promise<void> {
  const entries = [...fingerprints.entries()]
  if (entries.length === 0) return

  // Batched multi-row upserts: a large library has thousands of directories and
  // one statement each would dominate the scan time.
  for (let i = 0; i < entries.length; i += 500) {
    const batch = entries.slice(i, i + 500)
    await db
      .insert(schema.libraryDirs)
      .values(
        batch.map(([relPath, fingerprint]) => ({
          libraryId,
          relPath,
          mtimeMs: fingerprint.mtimeMs,
          entryCount: fingerprint.entryCount,
          lastSeenAt: seenAt,
        })),
      )
      .onConflictDoUpdate({
        target: [schema.libraryDirs.libraryId, schema.libraryDirs.relPath],
        set: {
          mtimeMs: sql`excluded.mtime_ms`,
          entryCount: sql`excluded.entry_count`,
          lastSeenAt: sql`excluded.last_seen_at`,
        },
      })
  }

  // Directories that vanished stop being tracked, so their fingerprints cannot
  // wrongly suppress a future scan if the path reappears.
  await db
    .delete(schema.libraryDirs)
    .where(
      and(eq(schema.libraryDirs.libraryId, libraryId), lt(schema.libraryDirs.lastSeenAt, seenAt)),
    )
}

export { markMissing as __markMissingForTests, countModelsNotIn as __countModelsNotInForTests }

/**
 * Applies a sidecar's metadata to a newly discovered model.
 *
 * Only ever called for a model created by this scan. Creators and tags are
 * created as needed, so a library moved to a fresh instance rebuilds its whole
 * taxonomy from the folders themselves.
 */
async function restoreFromSidecar(
  db: Database,
  storage: StorageAdapter,
  modelId: string,
  modelPath: string,
): Promise<boolean> {
  const { data, error } = await readSidecar(storage, modelPath)
  if (error) {
    console.warn(`[scan] ignoring sidecar for ${modelPath}: ${error}`)
    return false
  }
  if (!data) return false

  const updates: string[] = []
  if (data.name) updates.push('name')
  if (data.notes !== undefined) updates.push('notes')
  if (data.license !== undefined) updates.push('license')

  await db.execute(sql`
    UPDATE models SET
      name = coalesce(${data.name ?? null}, name),
      slug = coalesce(${data.name ? slugify(data.name) : null}, slug),
      notes = coalesce(${data.notes ?? null}, notes),
      license = coalesce(${data.license ?? null}, license)
    WHERE id = ${modelId}
  `)

  if (data.creator) {
    const creator = await db.execute<{ id: string }>(sql`
      INSERT INTO creators (name, slug, public_id)
      VALUES (${data.creator}, ${slugify(data.creator) || 'creator'}, ${nanoid(12)})
      ON CONFLICT (slug) DO UPDATE SET name = creators.name
      RETURNING id
    `)
    await db.execute(sql`
      UPDATE models SET creator_id = ${creator.rows[0]!.id} WHERE id = ${modelId}
    `)
    updates.push('creator')
  }

  if (data.tags?.length) {
    for (const name of data.tags) {
      const tag = await db.execute<{ id: string }>(sql`
        INSERT INTO tags (name, slug) VALUES (${name}, ${slugify(name) || 'tag'})
        ON CONFLICT (slug) DO UPDATE SET name = tags.name
        RETURNING id
      `)
      await db.execute(sql`
        INSERT INTO model_tags (model_id, tag_id) VALUES (${modelId}, ${tag.rows[0]!.id})
        ON CONFLICT DO NOTHING
      `)
    }
    updates.push(`${data.tags.length} tags`)
  }

  return updates.length > 0
}
