'use server'

import { revalidatePath } from 'next/cache'
import {
  PhotoValidationError,
  PolicyError,
  assertCan,
  deletePhoto,
  getPhotoOwner,
  updatePhoto,
} from '@pb/core'
import { requireUser } from '@pb/auth'
import { getDb } from '@pb/db'
import { audit } from '@/lib/audit'

/**
 * Editing and removing photographs.
 *
 * The upload itself is a route handler — a Server Action's body is capped at
 * a megabyte — but a caption and a print link are a few bytes, so those stay
 * here where the revalidation and the audit trail already live.
 */

type Result = { ok: true } | { ok: false; error: string }

function describe(error: unknown, fallback: string): string {
  if (error instanceof PolicyError) return 'Not permitted.'
  if (error instanceof PhotoValidationError) return error.message
  return fallback
}

export async function editPhoto(
  publicId: string,
  photoId: string,
  patch: { caption?: string | null; printRunId?: string | null },
): Promise<Result> {
  try {
    const user = await requireUser()
    const policyUser = { id: user.id, role: user.role ?? null, banned: user.banned ?? false }

    const owner = await getPhotoOwner(getDb(), photoId)
    if (!owner) return { ok: false, error: 'That photo no longer exists.' }

    assertCan(policyUser, 'photo:manage', { userId: owner.userId })

    await updatePhoto(getDb(), photoId, patch)
    await audit(user, 'photo.updated', { type: 'model', id: publicId })

    revalidatePath(`/models/${publicId}`)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: describe(error, 'Could not save that photo.') }
  }
}

export async function removePhoto(publicId: string, photoId: string): Promise<Result> {
  try {
    const user = await requireUser()
    const policyUser = { id: user.id, role: user.role ?? null, banned: user.banned ?? false }

    const owner = await getPhotoOwner(getDb(), photoId)
    // Already gone is the outcome the caller wanted.
    if (!owner) return { ok: true }

    assertCan(policyUser, 'photo:manage', { userId: owner.userId })

    await deletePhoto(getDb(), photoId)
    await audit(user, 'photo.deleted', { type: 'model', id: publicId })

    revalidatePath(`/models/${publicId}`)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: describe(error, 'Could not delete that photo.') }
  }
}
