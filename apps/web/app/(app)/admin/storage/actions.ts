'use server'

import { revalidatePath } from 'next/cache'
import { requireUser } from '@pb/auth'
import {
  assertCan,
  createS3Connection,
  deleteS3Connection,
  PolicyError,
  updateS3Connection,
  type S3ConnectionInput,
} from '@pb/core'
import { getDb } from '@pb/db'
import { audit } from '@/lib/audit'

type Result = { ok: true } | { ok: false; error: string }

/** The same permission as libraries: a connection is what a library is made of. */
async function assertAdmin() {
  const user = await requireUser()
  assertCan(
    { id: user.id, role: user.role ?? null, banned: user.banned ?? false },
    'library:manage',
  )
  return user
}

function done() {
  revalidatePath('/admin/storage')
  revalidatePath('/admin/libraries')
}

function failure(error: unknown, fallback: string): Result {
  if (error instanceof PolicyError) return { ok: false, error: 'Not permitted.' }
  console.error('[storage]', fallback, error)
  return { ok: false, error: error instanceof Error ? error.message : fallback }
}

export async function createConnection(input: S3ConnectionInput): Promise<Result> {
  try {
    const actor = await assertAdmin()
    const created = await createS3Connection(getDb(), input)
    if (!created.ok) return created

    await audit(
      actor,
      'storage.created',
      { type: 's3_connection', id: created.data.id, label: created.data.name },
      // Whether a key is stored, never which: the audit log is readable by admins
      // who should not learn credentials from it.
      { bucket: input.bucket.trim(), credentials: input.accessKeyId?.trim() ? 'key' : 'server' },
    )
    done()
    return { ok: true }
  } catch (error) {
    return failure(error, 'Could not add the connection.')
  }
}

export async function updateConnection(id: string, input: S3ConnectionInput): Promise<Result> {
  try {
    const actor = await assertAdmin()
    const updated = await updateS3Connection(getDb(), id, input)
    if (!updated.ok) return updated

    if (updated.data.changed.length > 0) {
      await audit(
        actor,
        'storage.updated',
        { type: 's3_connection', id, label: updated.data.name },
        { changed: updated.data.changed.join(', '), libraries: updated.data.libraryCount },
      )
    }
    done()
    return { ok: true }
  } catch (error) {
    return failure(error, 'Could not save the connection.')
  }
}

export async function deleteConnection(id: string): Promise<Result> {
  try {
    const actor = await assertAdmin()
    const removed = await deleteS3Connection(getDb(), id)
    if (!removed.ok) return removed

    await audit(actor, 'storage.deleted', {
      type: 's3_connection',
      id,
      label: removed.data.name,
    })
    done()
    return { ok: true }
  } catch (error) {
    return failure(error, 'Could not remove the connection.')
  }
}
