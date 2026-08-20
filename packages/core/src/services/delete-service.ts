import { and, eq, sql } from 'drizzle-orm'
import type { Database } from '@pm/db'
import { schema } from '@pm/db'
import { ReadOnlyLibraryError, type StorageAdapter } from '../storage/types'

/**
 * Removing a model.
 *
 * Two genuinely different things share the word "delete", and conflating them
 * is how a file manager loses somebody's files:
 *
 * **Remove from the library** forgets the model. The files are not touched.
 * This is the only option for a library pointed at folders the user already
 * had, and it is the default everywhere, because this application's central
 * promise is that it does not modify what it did not create.
 *
 * **Delete the files** actually deletes them, and is offered only for a
 * library this application owns and writes to. There is no undo — the
 * storage adapter refuses to write to an in-place library at all, so the
 * promise is enforced a layer below this one as well.
 *
 * Removing records an exclusion. Without it the next scan finds the folder
 * still sitting on disk and recreates the model, which looks exactly like the
 * delete button not working.
 */

export interface RemoveResult {
  /** Files left where they were. */
  filesKept: boolean
  path: string
  name: string
}

export interface DeleteResult {
  filesDeleted: number
  bytesFreed: number
  /** Files that could not be removed, with the reason. */
  failures: { path: string; reason: string }[]
}

export class DeleteError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DeleteError'
  }
}

interface ModelRow {
  id: string
  libraryId: string
  path: string
  name: string
  isFileModel: boolean
}

async function loadModel(db: Database, modelId: string): Promise<ModelRow> {
  const rows = await db
    .select({
      id: schema.models.id,
      libraryId: schema.models.libraryId,
      path: schema.models.path,
      name: schema.models.name,
      isFileModel: schema.models.isFileModel,
    })
    .from(schema.models)
    .where(eq(schema.models.id, modelId))
    .limit(1)

  const model = rows[0]
  if (!model) throw new DeleteError('That model no longer exists.')
  return model
}

/**
 * Forgets a model, leaving every file where it is.
 *
 * The exclusion is the point. Deleting the row on its own means the next scan
 * walks the same folder, finds the same files, and creates the model again —
 * so the button appears to do nothing, or worse, to work until the next scan.
 */
export async function removeModel(
  db: Database,
  modelId: string,
  userId?: string,
): Promise<RemoveResult> {
  const model = await loadModel(db, modelId)

  await db.execute(sql`
    INSERT INTO model_exclusions (library_id, path, name, excluded_by)
    VALUES (${model.libraryId}, ${model.path}, ${model.name}, ${userId ?? null})
    ON CONFLICT (library_id, path) DO UPDATE
      SET excluded_at = now(), name = excluded.name, excluded_by = excluded.excluded_by`)

  // Files, tags, collection membership and print history all cascade.
  await db.delete(schema.models).where(eq(schema.models.id, modelId))

  return { filesKept: true, path: model.path, name: model.name }
}

/**
 * Deletes the model's files from disk, then forgets it.
 *
 * Only for a library this application owns. `assertWritable` in the storage
 * adapter is what actually enforces that — this check exists so the refusal
 * arrives as an explanation rather than an exception from two layers down.
 *
 * No exclusion is recorded: the files are gone, so there is nothing for a scan
 * to find and nothing to suppress.
 */
export async function deleteModelFiles(
  db: Database,
  storage: StorageAdapter,
  modelId: string,
): Promise<DeleteResult> {
  const model = await loadModel(db, modelId)

  if (storage.library.kind === 'in_place' && !storage.library.allowWrites) {
    throw new DeleteError(
      'That library is read-only, so its files are never modified. ' +
        'Remove the model from the library instead, or delete the files yourself.',
    )
  }

  const files = await db
    .select({ filename: schema.modelFiles.filename, size: schema.modelFiles.size })
    .from(schema.modelFiles)
    .where(eq(schema.modelFiles.modelId, modelId))

  const result: DeleteResult = { filesDeleted: 0, bytesFreed: 0, failures: [] }

  for (const file of files) {
    // A model that is a single loose file has no folder of its own.
    const relativePath = model.isFileModel ? model.path : `${model.path}/${file.filename}`

    try {
      await storage.remove(relativePath)
      result.filesDeleted++
      result.bytesFreed += Number(file.size ?? 0)
    } catch (error) {
      if (error instanceof ReadOnlyLibraryError) throw error
      /*
       * Recorded rather than thrown. A file already gone, or locked by another
       * process, should not strand the rest — and the caller needs to know
       * which ones survived so the row is not dropped while files remain.
       */
      result.failures.push({
        path: relativePath,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /*
   * The index row goes only when the disk is actually clear. Dropping it while
   * files remain would leave orphans nothing knows about, and the next scan
   * would recreate the model anyway — with none of its metadata.
   */
  if (result.failures.length === 0) {
    await db.delete(schema.models).where(eq(schema.models.id, modelId))
  }

  return result
}

export interface Exclusion {
  libraryId: string
  libraryName: string
  path: string
  name: string | null
  excludedAt: Date
}

/** What has been removed, so it can be found again and put back. */
export async function listExclusions(
  db: Database,
  libraryId?: string,
): Promise<Exclusion[]> {
  const rows = await db.execute<{
    library_id: string
    library_name: string
    path: string
    name: string | null
    excluded_at: string
  }>(sql`
    SELECT e.library_id, l.name AS library_name, e.path, e.name, e.excluded_at
    FROM model_exclusions e
    JOIN libraries l ON l.id = e.library_id
    ${libraryId ? sql`WHERE e.library_id = ${libraryId}` : sql``}
    ORDER BY e.excluded_at DESC
    LIMIT 500`)

  return rows.rows.map((row) => ({
    libraryId: row.library_id,
    libraryName: row.library_name,
    path: row.path,
    name: row.name,
    excludedAt: new Date(row.excluded_at),
  }))
}

/**
 * Undoes a removal.
 *
 * Only lifts the exclusion — the model comes back at the next scan, rebuilt
 * from the files and its sidecar. Anything typed into the app and not written
 * to a sidecar was lost when the row was deleted, which is worth saying out
 * loud rather than implying "undo" restores everything.
 */
export async function restoreExclusion(
  db: Database,
  libraryId: string,
  path: string,
): Promise<boolean> {
  const result = await db
    .delete(schema.modelExclusions)
    .where(
      and(
        eq(schema.modelExclusions.libraryId, libraryId),
        eq(schema.modelExclusions.path, path),
      ),
    )
  return (result.rowCount ?? 0) > 0
}

/** Paths a scan must not recreate, for one library. */
export async function excludedPaths(db: Database, libraryId: string): Promise<Set<string>> {
  const rows = await db
    .select({ path: schema.modelExclusions.path })
    .from(schema.modelExclusions)
    .where(eq(schema.modelExclusions.libraryId, libraryId))

  return new Set(rows.map((row) => row.path))
}
