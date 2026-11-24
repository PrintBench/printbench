import { and, asc, eq, isNotNull, isNull, ne } from 'drizzle-orm'
import type { Database } from '@pb/db'
import { schema } from '@pb/db'
import { withLibraryScanLock } from '../scan/library-scan-lock'
import { createStorageAdapter } from '../storage/factory'
import { describeS3Error } from '../storage/s3-adapter'
import type { StorageAdapter, StorageEntry } from '../storage/types'
import { moveModelToLibrary } from './move-service'
import {
  normalizeS3Prefix,
  resolveLibraryLocation,
  type ServiceResult,
} from './s3-connection-service'

/**
 * Removing a library, in one of three ways.
 *
 * - **forget**: drop the index and leave every file where it is. Always
 *   available, and what removing a library has always meant.
 * - **delete_files**: delete everything under the library's folder or S3
 *   prefix, then forget it. The way to actually empty a bucket.
 * - **move**: move every model into another library, keeping its tags, notes,
 *   print history and share links, then forget the now-empty library.
 *
 * The last two only exist for libraries PrintBench owns (uploads libraries).
 * An existing-files library is read-only by promise: nothing in it is ever
 * deleted, and a move deletes the original, so neither is offered there. The
 * storage adapter refuses both regardless; this layer only says so first.
 *
 * Both are slow, potentially multi-gigabyte work, so they are requested here
 * and carried out by the worker (`library.remove`). The request is recorded on
 * the library row, which is what tells scans, uploads and moves to leave it
 * alone, and what the libraries page shows while it runs. The row goes once
 * the work has finished cleanly. If anything is left behind it stays, with the
 * reason, because a library that still has files must not quietly vanish
 * from the index.
 */

export type LibraryRemovalRequest =
  { mode: 'forget' } | { mode: 'delete_files' } | { mode: 'move'; destinationLibraryId: string }

export interface LibraryRemovalOptions {
  canDeleteFiles: boolean
  canMove: boolean
  /** Why neither is offered, when they are not. */
  reason: string | null
  /** Libraries the models could be moved into. */
  destinations: { id: string; name: string }[]
}

interface LibraryRow {
  id: string
  name: string
  kind: 'in_place' | 'managed'
  backend: 'local' | 's3'
  allowWrites: boolean
  path: string | null
  s3ConnectionId: string | null
  s3Prefix: string | null
  removalMode: 'delete_files' | 'move' | null
  removalDestinationId: string | null
}

/**
 * A failure in words an admin can act on.
 *
 * Not just `error.message`: a refused connection reaches here as an error with
 * an empty message, which left the removal dialog showing a blank red box
 * for a bucket whose server was down. S3 errors go through the same
 * translation the rest of the app uses.
 */
function describeFailure(error: unknown, storage: StorageAdapter): string {
  if (storage.library.backend === 's3') {
    return describeS3Error(error, storage.library.s3Bucket ?? '')
  }
  const message = error instanceof Error ? error.message : String(error ?? '')
  return message.trim() || 'an unknown error'
}

const READ_ONLY_REASON =
  'This library indexes files you already had, so they are never deleted or moved. ' +
  'Removing it only forgets the index.'

async function loadLibrary(db: Database, libraryId: string): Promise<LibraryRow | null> {
  const [row] = await db
    .select({
      id: schema.libraries.id,
      name: schema.libraries.name,
      kind: schema.libraries.kind,
      backend: schema.libraries.backend,
      allowWrites: schema.libraries.allowWrites,
      path: schema.libraries.path,
      s3ConnectionId: schema.libraries.s3ConnectionId,
      s3Prefix: schema.libraries.s3Prefix,
      removalMode: schema.libraries.removalMode,
      removalDestinationId: schema.libraries.removalDestinationId,
    })
    .from(schema.libraries)
    .where(eq(schema.libraries.id, libraryId))
    .limit(1)
  return row ?? null
}

function hasStorage(library: Pick<LibraryRow, 'backend' | 'path' | 's3ConnectionId'>): boolean {
  return library.backend === 'local' ? Boolean(library.path) : Boolean(library.s3ConnectionId)
}

/** Other uploads libraries a library's models could be moved into. */
async function moveDestinations(db: Database, libraryId: string) {
  const rows = await db
    .select({
      id: schema.libraries.id,
      name: schema.libraries.name,
      backend: schema.libraries.backend,
      path: schema.libraries.path,
      s3ConnectionId: schema.libraries.s3ConnectionId,
    })
    .from(schema.libraries)
    .where(
      and(
        ne(schema.libraries.id, libraryId),
        eq(schema.libraries.kind, 'managed'),
        isNull(schema.libraries.removalMode),
      ),
    )
    .orderBy(asc(schema.libraries.name))
  return rows.filter(hasStorage).map(({ id, name }) => ({ id, name }))
}

/** A move removal heading into this library, which must finish before it can go. */
async function incomingMove(db: Database, libraryId: string): Promise<string | null> {
  const [row] = await db
    .select({ name: schema.libraries.name })
    .from(schema.libraries)
    .where(
      and(
        eq(schema.libraries.removalDestinationId, libraryId),
        eq(schema.libraries.removalMode, 'move'),
      ),
    )
    .limit(1)
  return row?.name ?? null
}

export async function libraryRemovalOptions(
  db: Database,
  libraryId: string,
): Promise<LibraryRemovalOptions> {
  const library = await loadLibrary(db, libraryId)
  if (!library || library.kind !== 'managed') {
    return { canDeleteFiles: false, canMove: false, reason: READ_ONLY_REASON, destinations: [] }
  }
  if (!hasStorage(library)) {
    return {
      canDeleteFiles: false,
      canMove: false,
      reason: 'This library has no storage configured, so there are no files to delete or move.',
      destinations: [],
    }
  }
  const destinations = await moveDestinations(db, libraryId)
  return { canDeleteFiles: true, canMove: destinations.length > 0, reason: null, destinations }
}

/**
 * Checks a removal request and either forgets the library at once (`forget`)
 * or records the request for the worker. The caller queues the job.
 */
export async function requestLibraryRemoval(
  db: Database,
  libraryId: string,
  request: LibraryRemovalRequest,
): Promise<ServiceResult<{ name: string; backend: 'local' | 's3'; queued: boolean }>> {
  const library = await loadLibrary(db, libraryId)
  if (!library) return { ok: false, error: 'That library no longer exists.' }
  if (library.removalMode) {
    return { ok: false, error: 'That library is already being removed.' }
  }

  const incoming = await incomingMove(db, libraryId)
  if (incoming) {
    return {
      ok: false,
      error: `“${incoming}” is moving its models into this library. Wait for that to finish first.`,
    }
  }

  if (request.mode === 'forget') {
    // Removes the index only. The files are never touched.
    const [removed] = await db
      .delete(schema.libraries)
      .where(and(eq(schema.libraries.id, libraryId), isNull(schema.libraries.removalMode)))
      .returning({ name: schema.libraries.name, backend: schema.libraries.backend })
    if (!removed) return { ok: false, error: 'That library is already being removed.' }
    return { ok: true, data: { ...removed, queued: false } }
  }

  const options = await libraryRemovalOptions(db, libraryId)
  if (request.mode === 'delete_files' && !options.canDeleteFiles) {
    return { ok: false, error: options.reason ?? 'This library’s files cannot be deleted.' }
  }
  if (request.mode === 'move') {
    if (!options.canMove) {
      return { ok: false, error: options.reason ?? 'There is no other library to move into.' }
    }
    if (!options.destinations.some((d) => d.id === request.destinationLibraryId)) {
      return { ok: false, error: 'Choose an uploads library to move the models into.' }
    }
  }

  // Conditional, so two requests racing for the same library cannot both win.
  const [marked] = await db
    .update(schema.libraries)
    .set({
      removalMode: request.mode,
      removalDestinationId: request.mode === 'move' ? request.destinationLibraryId : null,
      removalRequestedAt: new Date(),
      removalError: null,
      updatedAt: new Date(),
    })
    .where(and(eq(schema.libraries.id, libraryId), isNull(schema.libraries.removalMode)))
    .returning({ id: schema.libraries.id })
  if (!marked) return { ok: false, error: 'That library is already being removed.' }

  return { ok: true, data: { name: library.name, backend: library.backend, queued: true } }
}

/**
 * Roots of other libraries that sit inside this one, relative to it.
 *
 * Deleting "everything under" a library must not reach into another
 * library's files. Uniqueness only stops two libraries sharing a location, not
 * one nesting inside the other: a library on a whole bucket and another on
 * its `models/` prefix can both exist.
 */
export async function nestedLibraryRoots(db: Database, libraryId: string): Promise<string[]> {
  const library = await loadLibrary(db, libraryId)
  if (!library) return []

  if (library.backend === 'local') {
    if (!library.path) return []
    const root = library.path.replace(/\/+$/, '')
    const others = await db
      .select({ path: schema.libraries.path })
      .from(schema.libraries)
      .where(
        and(
          ne(schema.libraries.id, libraryId),
          eq(schema.libraries.backend, 'local'),
          isNotNull(schema.libraries.path),
        ),
      )
    return others
      .map((other) => other.path!.replace(/\/+$/, ''))
      .filter((other) => other.startsWith(`${root}/`))
      .map((other) => other.slice(root.length + 1))
  }

  if (!library.s3ConnectionId) return []
  const [mine] = await db
    .select({ bucket: schema.s3Connections.bucket, endpoint: schema.s3Connections.endpoint })
    .from(schema.s3Connections)
    .where(eq(schema.s3Connections.id, library.s3ConnectionId))
  if (!mine) return []

  const others = await db
    .select({ prefix: schema.libraries.s3Prefix, endpoint: schema.s3Connections.endpoint })
    .from(schema.libraries)
    .innerJoin(schema.s3Connections, eq(schema.s3Connections.id, schema.libraries.s3ConnectionId))
    .where(and(ne(schema.libraries.id, libraryId), eq(schema.s3Connections.bucket, mine.bucket)))

  const prefix = normalizeS3Prefix(library.s3Prefix)
  return others
    .filter((other) => (other.endpoint ?? null) === (mine.endpoint ?? null))
    .map((other) => normalizeS3Prefix(other.prefix))
    .filter((other): other is string => other !== null)
    .filter((other) => (prefix === null ? true : other.startsWith(`${prefix}/`)))
    .map((other) => (prefix === null ? other : other.slice(prefix.length + 1)))
}

export interface LibraryContents {
  files: StorageEntry[]
  /** Folders seen, deepest first, never including the root itself. */
  directories: string[]
  /** Stopped at `limit` before seeing everything. */
  truncated: boolean
}

/** True when `path` is a nested library's root, or inside one. */
function insideAny(path: string, roots: string[]): boolean {
  return roots.some((root) => path === root || path.startsWith(`${root}/`))
}

/** Every file under a library's root, skipping nested libraries entirely. */
export async function listLibraryContents(
  storage: StorageAdapter,
  options: { skip: string[]; limit?: number },
): Promise<LibraryContents> {
  const files: StorageEntry[] = []
  const directories: string[] = []
  const queue = ['']
  let truncated = false

  while (queue.length > 0) {
    const dir = queue.shift()!
    for (const entry of await storage.list(dir)) {
      if (insideAny(entry.path, options.skip)) continue
      if (entry.isDirectory) {
        directories.push(entry.path)
        queue.push(entry.path)
      } else {
        files.push(entry)
        if (options.limit !== undefined && files.length >= options.limit) {
          truncated = true
          queue.length = 0
          break
        }
      }
    }
  }

  // Deepest first, so a folder is only removed once everything in it has gone.
  directories.sort((a, b) => b.split('/').length - a.split('/').length)
  return { files, directories, truncated }
}

export interface LibraryDeletionPreview {
  files: number
  bytes: number
  /** Counted no further than this; the real numbers are higher. */
  truncated: boolean
  /** Where the files are, for the confirmation to name. */
  location: string
  /** Libraries inside this one that will be left untouched. */
  nested: string[]
}

const PREVIEW_LIMIT = 50_000

/** What "delete the files too" would delete, for the admin to see first. */
export async function previewLibraryDeletion(
  db: Database,
  libraryId: string,
): Promise<ServiceResult<LibraryDeletionPreview>> {
  const options = await libraryRemovalOptions(db, libraryId)
  if (!options.canDeleteFiles) {
    return { ok: false, error: options.reason ?? 'This library’s files cannot be deleted.' }
  }

  const [row] = await db
    .select()
    .from(schema.libraries)
    .where(eq(schema.libraries.id, libraryId))
    .limit(1)
  if (!row) return { ok: false, error: 'That library no longer exists.' }

  const location = await resolveLibraryLocation(db, row)
  const storage = createStorageAdapter(location)
  const skip = await nestedLibraryRoots(db, libraryId)
  let contents: LibraryContents
  try {
    contents = await listLibraryContents(storage, { skip, limit: PREVIEW_LIMIT })
  } catch (error) {
    ;(storage as { destroy?: () => void }).destroy?.()
    return { ok: false, error: `Could not list the files: ${describeFailure(error, storage)}` }
  }
  try {
    return {
      ok: true,
      data: {
        files: contents.files.length,
        bytes: contents.files.reduce((total, file) => total + (file.size ?? 0), 0),
        truncated: contents.truncated,
        location:
          location.backend === 's3'
            ? `s3://${location.s3Bucket}/${location.s3Prefix ? `${normalizeS3Prefix(location.s3Prefix)}/` : ''}`
            : (location.path ?? ''),
        nested: skip,
      },
    }
  } finally {
    ;(storage as { destroy?: () => void }).destroy?.()
  }
}

export interface LibraryRemovalOutcome {
  status: 'removed' | 'stopped' | 'nothing_to_do'
  name: string
  mode: 'delete_files' | 'move' | null
  filesDeleted: number
  bytesFreed: number
  modelsMoved: number
  /** Models already missing from disk, which go with the library. */
  modelsMissing: number
  /** Folders a move left behind because they held files it never indexed. */
  foldersKept: number
  /** What could not be done, one line each. */
  failures: string[]
  /** Set when status is `stopped`: what the admin sees on the library. */
  error: string | null
}

function summarise(failures: string[], what: string): string {
  const shown = failures.slice(0, 3).join('; ')
  const more = failures.length > 3 ? `; and ${failures.length - 3} more` : ''
  return `${failures.length} ${what}: ${shown}${more}. The library was kept so nothing is lost from the index; remove it again to retry.`
}

/**
 * Carries out a recorded removal. Called by the worker job.
 *
 * Held under the library's scan lock throughout, so no scan runs while files
 * are disappearing. A scan halfway through a deletion would see most of the
 * library go missing and record it, or trip its own mass-deletion guard.
 */
export async function carryOutLibraryRemoval(
  db: Database,
  libraryId: string,
): Promise<LibraryRemovalOutcome> {
  const library = await loadLibrary(db, libraryId)
  const outcome: LibraryRemovalOutcome = {
    status: 'nothing_to_do',
    name: library?.name ?? '',
    mode: library?.removalMode ?? null,
    filesDeleted: 0,
    bytesFreed: 0,
    modelsMoved: 0,
    modelsMissing: 0,
    foldersKept: 0,
    failures: [],
    error: null,
  }
  if (!library || !library.removalMode) return outcome

  const stop = async (error: string) => {
    await db
      .update(schema.libraries)
      .set({
        removalMode: null,
        removalDestinationId: null,
        removalError: error,
        updatedAt: new Date(),
      })
      .where(eq(schema.libraries.id, libraryId))
    return { ...outcome, status: 'stopped' as const, error }
  }

  try {
    return await withLibraryScanLock(db, libraryId, async () => {
      const [row] = await db
        .select()
        .from(schema.libraries)
        .where(eq(schema.libraries.id, libraryId))
        .limit(1)
      if (!row) return outcome
      const source = createStorageAdapter(await resolveLibraryLocation(db, row))

      if (library.removalMode === 'delete_files') {
        const skip = await nestedLibraryRoots(db, libraryId)
        const contents = await listLibraryContents(source, { skip })
        for (const file of contents.files) {
          try {
            await source.remove(file.path)
            outcome.filesDeleted++
            outcome.bytesFreed += file.size ?? 0
          } catch (error) {
            outcome.failures.push(`${file.path} (${describeFailure(error, source)})`)
          }
        }
        /*
         * Local folders are left empty once their files go; S3 has no folders
         * to remove. Only when every file went, and never a folder that still
         * holds another library: `remove` on a local folder is recursive.
         */
        if (outcome.failures.length === 0 && row.backend === 'local') {
          for (const dir of contents.directories) {
            if (skip.some((root) => root.startsWith(`${dir}/`))) continue
            try {
              await source.remove(dir)
            } catch (error) {
              outcome.failures.push(`${dir}/ (${describeFailure(error, source)})`)
            }
          }
        }
        if (outcome.failures.length > 0) {
          return await stop(summarise(outcome.failures, 'files could not be deleted'))
        }
      } else {
        const destinationRow = library.removalDestinationId
          ? (
              await db
                .select()
                .from(schema.libraries)
                .where(eq(schema.libraries.id, library.removalDestinationId))
                .limit(1)
            )[0]
          : undefined
        if (!destinationRow || destinationRow.kind !== 'managed' || destinationRow.removalMode) {
          return await stop(
            'The library chosen to receive the models is gone or no longer accepts them. Nothing was moved.',
          )
        }
        const destination = createStorageAdapter(await resolveLibraryLocation(db, destinationRow))

        const models = await db
          .select({
            id: schema.models.id,
            name: schema.models.name,
            missingAt: schema.models.missingAt,
          })
          .from(schema.models)
          .where(eq(schema.models.libraryId, libraryId))
          .orderBy(asc(schema.models.path))

        for (const model of models) {
          // Nothing on disk to carry across. It goes with the library.
          if (model.missingAt) {
            outcome.modelsMissing++
            continue
          }
          try {
            const moved = await moveModelToLibrary(db, source, destination, model.id)
            outcome.modelsMoved++
            if (moved.sourceFolderKept) outcome.foldersKept++
          } catch (error) {
            outcome.failures.push(`“${model.name}” (${describeFailure(error, source)})`)
          }
        }
        if (outcome.failures.length > 0) {
          return await stop(summarise(outcome.failures, 'models could not be moved'))
        }
      }

      await db.delete(schema.libraries).where(eq(schema.libraries.id, libraryId))
      return { ...outcome, status: 'removed' as const }
    })
  } catch (error) {
    // Unexpected, such as the bucket refusing a listing. Recorded on the row,
    // so the library page explains it rather than the removal hanging.
    const message = error instanceof Error ? error.message.trim() : ''
    return await stop(
      `The removal stopped: ${message || 'the storage could not be reached'}. Nothing more was changed.`,
    )
  }
}
