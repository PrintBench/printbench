'use server'

import { eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import {
  DeleteError,
  PolicyError,
  assertCan,
  createStorageAdapter,
  deleteModelFiles,
  libraryLocationFromRow,
  removeModel,
  restoreExclusion,
} from '@pb/core'
import { requireUser } from '@pb/auth'
import { getDb, schema } from '@pb/db'

type Result = { ok: true; message: string } | { ok: false; error: string }

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
 * Forgets a model. Files stay exactly where they are.
 *
 * The safe option, and the only one offered for a library pointed at folders
 * the user already had.
 */
export async function removeFromLibrary(publicId: string): Promise<Result> {
  try {
    const user = await requireUser()
    assertCan(
      { id: user.id, role: user.role ?? null, banned: user.banned ?? false },
      'model:delete',
    )

    const found = await locate(publicId)
    if (!found) return { ok: false, error: 'That model no longer exists.' }

    const result = await removeModel(getDb(), found.model.id, user.id)

    revalidatePath('/models')
    revalidatePath('/admin/libraries')
    revalidatePath('/')
    return {
      ok: true,
      message: `Removed "${result.name}". The files are still in ${found.library.name}.`,
    }
  } catch (error) {
    return fail(error, 'Could not remove that model.')
  }
}

/**
 * Deletes the model's files from disk.
 *
 * Only reaches the storage adapter for a library this application owns; the
 * adapter refuses anything else regardless of what is asked here.
 */
export async function deleteFiles(publicId: string): Promise<Result> {
  try {
    const user = await requireUser()
    assertCan(
      { id: user.id, role: user.role ?? null, banned: user.banned ?? false },
      'model:delete',
    )

    const found = await locate(publicId)
    if (!found) return { ok: false, error: 'That model no longer exists.' }

    const result = await deleteModelFiles(
      getDb(),
      createStorageAdapter(libraryLocationFromRow(found.library)),
      found.model.id,
    )

    if (result.failures.length > 0) {
      // The model is deliberately kept when anything survived, so say so
      // rather than reporting a success that left files behind.
      return {
        ok: false,
        error:
          `Deleted ${result.filesDeleted} file(s), but ${result.failures.length} could not be ` +
          `removed: ${result.failures[0]!.reason}. The model has been kept.`,
      }
    }

    revalidatePath('/models')
    revalidatePath('/')
    return {
      ok: true,
      message: `Deleted ${result.filesDeleted} file(s), freeing ${formatBytes(result.bytesFreed)}.`,
    }
  } catch (error) {
    return fail(error, 'Could not delete those files.')
  }
}

/** Lifts a removal so the next scan picks the folder up again. */
export async function restore(libraryId: string, path: string): Promise<Result> {
  try {
    const user = await requireUser()
    assertCan(
      { id: user.id, role: user.role ?? null, banned: user.banned ?? false },
      'model:delete',
    )

    const restored = await restoreExclusion(getDb(), libraryId, path)
    if (!restored) return { ok: false, error: 'That was not on the removed list.' }

    revalidatePath('/admin/libraries')
    return { ok: true, message: 'Restored. It reappears after the next scan of that library.' }
  } catch (error) {
    return fail(error, 'Could not restore that.')
  }
}

/** Sends the browser away from a model page that no longer has a model. */
export async function goToModels(): Promise<never> {
  redirect('/models')
}

function fail(error: unknown, fallback: string): Result {
  if (error instanceof DeleteError) return { ok: false, error: error.message }
  if (error instanceof PolicyError) return { ok: false, error: 'Not permitted.' }
  console.error('[delete]', error)
  return { ok: false, error: fallback }
}

function formatBytes(bytes: number): string {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / 1024 ** exponent).toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`
}
