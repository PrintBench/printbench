'use server'

import { revalidatePath } from 'next/cache'
import { eq } from 'drizzle-orm'
import { PolicyError, assertCan, toggleLike } from '@pb/core'
import { requireUser } from '@pb/auth'
import { getDb, schema } from '@pb/db'

type Result = { ok: true; liked: boolean } | { ok: false; error: string }

/**
 * Likes are per-user and available to anyone signed in, viewers included —
 * bookmarking something you cannot edit is exactly what a viewer wants.
 */
export async function toggleLiked(modelPublicId: string): Promise<Result> {
  try {
    const user = await requireUser()
    assertCan({ id: user.id, role: user.role ?? null, banned: user.banned ?? false }, 'like:toggle')

    const rows = await getDb()
      .select({ id: schema.models.id })
      .from(schema.models)
      .where(eq(schema.models.publicId, modelPublicId))
      .limit(1)

    const model = rows[0]
    if (!model) return { ok: false, error: 'That model no longer exists.' }

    const { liked } = await toggleLike(getDb(), user.id, model.id)

    revalidatePath('/lists')
    revalidatePath(`/models/${modelPublicId}`)
    return { ok: true, liked }
  } catch (error) {
    if (error instanceof PolicyError) return { ok: false, error: 'Not permitted.' }
    console.error('[likes]', error)
    return { ok: false, error: 'Could not save that.' }
  }
}
