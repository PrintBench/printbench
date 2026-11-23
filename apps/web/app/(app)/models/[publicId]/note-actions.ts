'use server'

import { eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import {
  NoteValidationError,
  PolicyError,
  assertCan,
  createNote,
  deleteNote,
  getNoteOwner,
  updateNote,
} from '@pb/core'
import { requireUser } from '@pb/auth'
import { getDb, schema } from '@pb/db'
import { audit } from '@/lib/audit'

/**
 * Model notes.
 *
 * The rules live in @pb/core; this layer only resolves the public id, decides
 * who is allowed, and says what happened. Editing is authorized against the
 * note's author rather than the role alone, so a member can correct their own
 * note and only an admin can touch somebody else's.
 */

type Result = { ok: true } | { ok: false; error: string }

async function modelIdFor(publicId: string): Promise<string | null> {
  const rows = await getDb()
    .select({ id: schema.models.id })
    .from(schema.models)
    .where(eq(schema.models.publicId, publicId))
    .limit(1)
  return rows[0]?.id ?? null
}

function describe(error: unknown, fallback: string): string {
  if (error instanceof PolicyError) return 'Not permitted.'
  if (error instanceof NoteValidationError) return error.message
  return fallback
}

export async function addNote(
  publicId: string,
  input: { body: string; printRunId?: string | null },
): Promise<Result> {
  try {
    const user = await requireUser()
    const policyUser = { id: user.id, role: user.role ?? null, banned: user.banned ?? false }
    assertCan(policyUser, 'note:create')

    const modelId = await modelIdFor(publicId)
    if (!modelId) return { ok: false, error: 'That model no longer exists.' }

    await createNote(getDb(), {
      modelId,
      userId: user.id,
      body: input.body,
      printRunId: input.printRunId ?? null,
    })

    // The note itself is not recorded: a workshop log is the author's words,
    // and the audit trail is read by whoever runs the instance.
    await audit(user, 'note.created', { type: 'model', id: publicId })

    revalidatePath(`/models/${publicId}`)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: describe(error, 'Could not save that note.') }
  }
}

export async function editNote(
  publicId: string,
  noteId: string,
  patch: { body?: string; printRunId?: string | null },
): Promise<Result> {
  try {
    const user = await requireUser()
    const policyUser = { id: user.id, role: user.role ?? null, banned: user.banned ?? false }

    const owner = await getNoteOwner(getDb(), noteId)
    if (!owner) return { ok: false, error: 'That note no longer exists.' }

    assertCan(policyUser, 'note:manage', { userId: owner.userId })

    await updateNote(getDb(), noteId, patch)
    await audit(user, 'note.updated', { type: 'model', id: publicId })

    revalidatePath(`/models/${publicId}`)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: describe(error, 'Could not save that note.') }
  }
}

export async function removeNote(publicId: string, noteId: string): Promise<Result> {
  try {
    const user = await requireUser()
    const policyUser = { id: user.id, role: user.role ?? null, banned: user.banned ?? false }

    const owner = await getNoteOwner(getDb(), noteId)
    // Already gone is the outcome the caller wanted.
    if (!owner) return { ok: true }

    assertCan(policyUser, 'note:manage', { userId: owner.userId })

    await deleteNote(getDb(), noteId)
    await audit(user, 'note.deleted', { type: 'model', id: publicId })

    revalidatePath(`/models/${publicId}`)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: describe(error, 'Could not delete that note.') }
  }
}
