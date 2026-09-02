import { and, eq, inArray } from 'drizzle-orm'
import type { Database } from '@pb/db'
import { schema } from '@pb/db'
import { isSafeRelativePath, joinPath, normalizePath } from '../library/paths'
import { moveFile, type MoveStrategy } from '../storage/move'
import { sidecarPath } from '../sidecar/sidecar'
import { syncSidecar } from './model-service'
import type { StorageAdapter } from '../storage/types'

/**
 * Moving a model from one library to another.
 *
 * The fix for uploading something to the wrong library, which until now meant
 * deleting the model and uploading it again — losing its tags, notes, creator,
 * licence, collections, print history and share link in the process, none of
 * which is recoverable once the row is gone.
 *
 * The point of doing it here rather than as a delete and a re-upload is that
 * the model row survives. Everything hangs off `models.id`; nothing hangs off
 * `library_id`. So a move is: carry the bytes across, then change two columns.
 * The id, the publicId behind every share link, and every row referencing them
 * are untouched, which is the whole difference between moving a model and
 * replacing it with a lookalike.
 *
 * File rows do not move either. `model_files.filename` is relative to the
 * model, not the library, so a model whose folder lands somewhere else keeps
 * every file row, digest and rendered thumbnail exactly as it was.
 */

export interface MoveModelOptions {
  /**
   * Where the model lands in the destination library. Defaults to the same
   * relative path it had, which is nearly always what is wanted — the folder
   * structure came from the user in the first place.
   */
  destinationPath?: string
}

export interface MoveModelResult {
  modelId: string
  name: string
  from: { libraryId: string; path: string }
  to: { libraryId: string; path: string }
  filesMoved: number
  bytesMoved: number
  /** 'direct' only when every file avoided a byte-for-byte transfer. */
  strategy: MoveStrategy
  /**
   * The source folder was left in place because something unindexed was still
   * in it. Reported rather than resolved: deleting files this application
   * never indexed is not its decision to make.
   */
  sourceFolderKept: boolean
  /** Live file rows skipped because the scan had already marked them missing. */
  filesSkipped: number
}

export class MoveError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MoveError'
  }
}

interface ModelRow {
  id: string
  libraryId: string
  path: string
  name: string
  isFileModel: boolean
}

/**
 * Moves a model's files into another library and repoints its row.
 *
 * Ordered so that every failure is recoverable. Files go first, one at a time
 * and rolled back if one fails part-way; the row changes only once they have
 * all arrived. A row updated first would point at files that are not there
 * yet, which is a broken model rather than a failed move.
 */
export async function moveModelToLibrary(
  db: Database,
  source: StorageAdapter,
  destination: StorageAdapter,
  modelId: string,
  options: MoveModelOptions = {},
): Promise<MoveModelResult> {
  const model = await loadModel(db, modelId)

  if (model.libraryId !== source.library.id) {
    // A caller that built the adapter from the wrong library would otherwise
    // read files from one place and record the move against another.
    throw new MoveError('That model is not in the library it was loaded from.')
  }
  if (source.library.id === destination.library.id) {
    throw new MoveError('That model is already in that library.')
  }

  assertWritable(source, 'moved out of')
  assertWritable(destination, 'moved into')

  const destinationPath = normalizePath(options.destinationPath ?? model.path)
  if (!isSafeRelativePath(destinationPath)) {
    throw new MoveError('That destination path is not valid.')
  }

  await assertNoRunningScan(db, [source.library.id, destination.library.id])
  await assertDestinationFree(db, destination, destinationPath)

  const allFiles = await db
    .select({
      filename: schema.modelFiles.filename,
      size: schema.modelFiles.size,
      missingAt: schema.modelFiles.missingAt,
    })
    .from(schema.modelFiles)
    .where(eq(schema.modelFiles.modelId, modelId))

  /*
   * Rows a scan has already marked missing are left behind, not moved. The
   * file is not on disk to move, and letting one absentee fail the whole move
   * would mean a model could never leave a library it had lost a file in.
   */
  const files = allFiles.filter((file) => file.missingAt === null)

  if (files.length === 0) {
    throw new MoveError('That model has no files to move.')
  }

  const moved: { from: string; to: string }[] = []
  let bytesMoved = 0
  let streamed = false

  for (const file of files) {
    // A single loose file has no folder of its own: its path IS the file.
    const from = model.isFileModel ? model.path : joinPath(model.path, file.filename)
    const to = model.isFileModel ? destinationPath : joinPath(destinationPath, file.filename)

    try {
      const outcome = await moveFile(source, destination, from, to)
      if (outcome.strategy === 'streamed') streamed = true
      moved.push({ from, to })
      bytesMoved += Number(file.size ?? 0)
    } catch (error) {
      /*
       * Put back what has already gone across.
       *
       * The alternative is a model split over two libraries with its row
       * pointing at neither half — repairable only by hand, and only by
       * someone who knows which files were in it. Rolling back returns the
       * library to the state it was in a moment ago, which is a state the user
       * recognises.
       */
      const stranded = await rollback(source, destination, moved, destinationPath)
      throw new MoveError(
        `Could not move "${file.filename}": ${reason(error)}.` +
          (stranded.length > 0
            ? ` ${stranded.length} file(s) could not be put back and are now in the ` +
              `destination library: ${stranded.join(', ')}.`
            : ' Nothing was moved.'),
      )
    }
  }

  const sourceFolderKept = model.isFileModel
    ? false
    : !(await clearSourceFolder(source, model.path))

  /*
   * The row, last and in one statement.
   *
   * `missing_at` is cleared deliberately. A scan of the source library that
   * ran while the files were in flight would have marked the model missing,
   * and leaving that set would hide a model that is now perfectly present.
   */
  await db
    .update(schema.models)
    .set({
      libraryId: destination.library.id,
      path: destinationPath,
      missingAt: null,
      lastSeenAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(schema.models.id, modelId))

  /*
   * Anything removed from the destination at this path previously would
   * otherwise make the next scan there skip the folder and mark the model
   * missing again — the removal outliving the model it was about.
   */
  await db
    .delete(schema.modelExclusions)
    .where(
      and(
        eq(schema.modelExclusions.libraryId, destination.library.id),
        eq(schema.modelExclusions.path, destinationPath),
      ),
    )

  // Best-effort, and already swallows its own write errors: the move has
  // happened either way, and the sidecar is a backup of the database rather
  // than the other way round.
  await syncSidecar(db, modelId)

  return {
    modelId,
    name: model.name,
    from: { libraryId: source.library.id, path: model.path },
    to: { libraryId: destination.library.id, path: destinationPath },
    filesMoved: moved.length,
    bytesMoved,
    strategy: streamed ? 'streamed' : 'direct',
    sourceFolderKept,
    filesSkipped: allFiles.length - files.length,
  }
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
  if (!model) throw new MoveError('That model no longer exists.')
  return model
}

/**
 * Both libraries have to be writable, for different reasons: one is written
 * to, the other has files taken away from it. The storage adapter refuses
 * either way — this exists so the refusal arrives as an explanation instead of
 * an exception from two layers down.
 */
function assertWritable(adapter: StorageAdapter, verb: string): void {
  const { kind, allowWrites } = adapter.library
  if (kind === 'managed' || allowWrites) return
  throw new MoveError(
    `That library is read-only, so its files are never ${verb}. ` +
      'Enable writes on it, or move the files yourself and rescan both libraries.',
  )
}

/**
 * Refuses to start while either library is being scanned.
 *
 * A scan of the destination that runs half way through a move finds a folder
 * with some of its files in it, decides that is a new model, and inserts a row
 * at the very path this move is about to claim — so the move then fails on the
 * unique index with the files already carried across.
 *
 * A check rather than a lock, so there is still a window between this and the
 * first file. Closing it properly means both operations taking the same
 * Postgres advisory lock, which is a change to the scanner and not to this.
 */
async function assertNoRunningScan(db: Database, libraryIds: string[]): Promise<void> {
  const running = await db
    .select({ libraryId: schema.scanRuns.libraryId })
    .from(schema.scanRuns)
    .where(
      and(eq(schema.scanRuns.status, 'running'), inArray(schema.scanRuns.libraryId, libraryIds)),
    )
    .limit(1)

  if (running.length > 0) {
    throw new MoveError('One of those libraries is being scanned. Try again once it has finished.')
  }
}

/**
 * Nothing may already be at the destination, in the index or on disk.
 *
 * Two checks because they catch different things. The index catches another
 * model already claiming the path — the unique index on (library_id, path)
 * would reject the update anyway, but only after every byte had been moved.
 * Storage catches files sitting there that no model has been built from yet,
 * which a move would otherwise mix into.
 */
async function assertDestinationFree(
  db: Database,
  destination: StorageAdapter,
  destinationPath: string,
): Promise<void> {
  const claimed = await db
    .select({ name: schema.models.name })
    .from(schema.models)
    .where(
      and(
        eq(schema.models.libraryId, destination.library.id),
        eq(schema.models.path, destinationPath),
      ),
    )
    .limit(1)

  if (claimed[0]) {
    throw new MoveError(
      `"${claimed[0].name}" is already at ${destinationPath} in that library. ` +
        'Rename one of them, or move it somewhere else.',
    )
  }

  if (await destination.stat(destinationPath)) {
    throw new MoveError(
      `There are already files at ${destinationPath} in that library, ` +
        'even though no model has been built from them yet.',
    )
  }
}

/**
 * Returns the files that could not be put back.
 *
 * Every failure is swallowed on purpose. This runs while another error is
 * already on its way up, and throwing here would replace the explanation of
 * what actually went wrong with an explanation of the clean-up going wrong.
 * The list is reported instead, since somebody has to be told where those
 * files ended up.
 */
async function rollback(
  source: StorageAdapter,
  destination: StorageAdapter,
  moved: { from: string; to: string }[],
  destinationPath: string,
): Promise<string[]> {
  const stranded: string[] = []

  for (const file of moved) {
    try {
      await moveFile(destination, source, file.to, file.from)
    } catch {
      stranded.push(file.to)
    }
  }

  /*
   * And the folders the move created on its way in. An emptied tree is not
   * nothing: the next scan of the destination walks it, finds a directory
   * where a model used to be arriving, and the failed move leaves a permanent
   * empty model behind as its only trace.
   */
  if (stranded.length === 0) await pruneEmptyFolder(destination, destinationPath)

  return stranded
}

/**
 * Removes the emptied source folder, and says whether it went.
 *
 * The sidecar goes first and explicitly: it is deliberately excluded from a
 * model's files, so nothing above moved it, and a folder containing nothing
 * but a sidecar still reads to the scanner as a model — the model that just
 * left, reappearing empty at the next scan.
 *
 * Anything else still in there is left exactly where it is, folder and all.
 * Those are files this application chose not to index, and deleting them to
 * tidy up after a move is not a decision it gets to make.
 */
async function clearSourceFolder(source: StorageAdapter, modelPath: string): Promise<boolean> {
  try {
    await source.remove(sidecarPath(modelPath))
  } catch {
    // Absent is the normal case.
  }

  return pruneEmptyFolder(source, modelPath)
}

/**
 * Removes a folder if nothing but empty folders is left in it. Says whether it
 * went.
 *
 * Recursive because a model's files are not all at its top level — "Red
 * Dragon/stl/wing.stl" is the ordinary shape of a downloaded pack, not an
 * unusual one. Checking only the top level finds an empty `stl` directory
 * still sitting there and concludes the user has files here worth keeping,
 * so every model with a subfolder leaves its skeleton behind on the way out.
 *
 * A single real file anywhere below stops the whole thing, folder and all.
 * Those are files this application chose not to index, and deleting them to
 * tidy up after a move is not a decision it gets to make.
 */
async function pruneEmptyFolder(storage: StorageAdapter, relativePath: string): Promise<boolean> {
  let entries
  try {
    entries = await storage.list(relativePath)
  } catch {
    // Already gone, or never a directory — a loose file model's path is the
    // file itself. Either way there is nothing here to prune.
    return false
  }

  let empty = true
  for (const entry of entries) {
    if (!entry.isDirectory) empty = false
    else if (!(await pruneEmptyFolder(storage, entry.path))) empty = false
  }

  if (!empty) return false

  try {
    await storage.remove(relativePath)
    return true
  } catch {
    // Not worth failing a completed move over; the next scan reports it.
    return false
  }
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
