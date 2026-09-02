'use server'

import { eq, or } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import {
  MoveError,
  PolicyError,
  assertCan,
  assertMoveAllowed,
  createStorageAdapter,
  libraryLocationFromRow,
} from '@pb/core'
import { requireUser } from '@pb/auth'
import { getDb, schema } from '@pb/db'
import { JOB, getQueue } from '@pb/jobs'

/**
 * Moving a model to another library.
 *
 * The work happens in the worker — a move between two backends copies every
 * byte, and that does not belong in the process rendering pages. But a queued
 * job can only report "started", so everything that would refuse the move is
 * checked here first and answered immediately. The job checks again, because
 * anything it checks can change between the click and the move.
 */

type Result = { ok: true; message: string } | { ok: false; error: string }

export interface MoveTarget {
  id: string
  name: string
  backend: 'local' | 's3'
  /** A model already sits at the path this one would take. */
  occupied: boolean
}

async function locate(publicId: string) {
  const rows = await getDb()
    .select({ model: schema.models, library: schema.libraries })
    .from(schema.models)
    .innerJoin(schema.libraries, eq(schema.libraries.id, schema.models.libraryId))
    .where(eq(schema.models.publicId, publicId))
    .limit(1)

  return rows[0]
}

/**
 * Libraries this model could move into.
 *
 * The same rule uploads use — managed always, in-place only where writes were
 * explicitly enabled — because a move is a write, and the promise that this
 * application does not touch folders it did not create holds either way.
 *
 * A library whose backend is not actually configured is left out rather than
 * offered and then failed at the last step.
 */
export async function listMoveTargets(publicId: string): Promise<MoveTarget[]> {
  try {
    const user = await requireUser()
    assertCan({ id: user.id, role: user.role ?? null, banned: user.banned ?? false }, 'model:edit')
  } catch {
    return []
  }

  const found = await locate(publicId)
  if (!found) return []

  const db = getDb()
  const rows = await db
    .select({
      id: schema.libraries.id,
      name: schema.libraries.name,
      backend: schema.libraries.backend,
      path: schema.libraries.path,
      s3Bucket: schema.libraries.s3Bucket,
    })
    .from(schema.libraries)
    .where(or(eq(schema.libraries.kind, 'managed'), eq(schema.libraries.allowWrites, true)))

  const candidates = rows.filter(
    (row) =>
      row.id !== found.model.libraryId &&
      (row.backend === 's3' ? Boolean(row.s3Bucket) : Boolean(row.path)),
  )

  if (candidates.length === 0) return []

  /*
   * Which of them already have something at this model's path.
   *
   * Shown on the option rather than discovered after choosing it: the answer
   * is a rename, and finding that out from an error message after picking a
   * library is a worse way to be told.
   */
  const taken = await db
    .select({ libraryId: schema.models.libraryId })
    .from(schema.models)
    .where(eq(schema.models.path, found.model.path))

  const occupied = new Set(taken.map((row) => row.libraryId))

  return candidates.map((row) => ({
    id: row.id,
    name: row.name,
    backend: row.backend,
    occupied: occupied.has(row.id),
  }))
}

/**
 * Checks the move, then queues it.
 *
 * The check is the useful half of this function. It runs against the same code
 * the job does, so a refusal shown here is the refusal the job would have
 * reached — rather than a second, looser opinion that lets through moves the
 * worker then declines silently.
 */
export async function moveToLibrary(
  publicId: string,
  destinationLibraryId: string,
  destinationPath?: string,
): Promise<Result> {
  try {
    const user = await requireUser()
    assertCan({ id: user.id, role: user.role ?? null, banned: user.banned ?? false }, 'model:edit')

    const db = getDb()
    const found = await locate(publicId)
    if (!found) return { ok: false, error: 'That model no longer exists.' }

    const destinationRows = await db
      .select()
      .from(schema.libraries)
      .where(eq(schema.libraries.id, destinationLibraryId))
      .limit(1)

    const destinationRow = destinationRows[0]
    if (!destinationRow) return { ok: false, error: 'That library no longer exists.' }

    await assertMoveAllowed(
      db,
      createStorageAdapter(libraryLocationFromRow(found.library)),
      createStorageAdapter(libraryLocationFromRow(destinationRow)),
      found.model.id,
      { destinationPath },
    )

    await getQueue().send(
      JOB.modelMove,
      {
        modelId: found.model.id,
        destinationLibraryId,
        destinationPath,
      },
      { singletonKey: `move:${found.model.id}` },
    )

    revalidatePath(`/models/${publicId}`)
    revalidatePath('/models')

    return {
      ok: true,
      message:
        `Moving "${found.model.name}" to ${destinationRow.name}. ` +
        'Its tags, notes and share link come with it.',
    }
  } catch (error) {
    if (error instanceof MoveError) return { ok: false, error: error.message }
    if (error instanceof PolicyError) return { ok: false, error: 'Not permitted.' }
    console.error('[move]', error)
    return { ok: false, error: 'Could not start that move.' }
  }
}

/**
 * Where the model is now, so the page can tell whether a queued move landed.
 *
 * The move happens in the worker, so the page that queued it has no way of
 * knowing when it finished. This is what the button polls — the library id
 * changing is the move completing, and it is one small query rather than a
 * progress-reporting mechanism this is the only user of.
 */
export async function currentLibrary(publicId: string): Promise<string | null> {
  const found = await locate(publicId)
  return found?.model.libraryId ?? null
}
