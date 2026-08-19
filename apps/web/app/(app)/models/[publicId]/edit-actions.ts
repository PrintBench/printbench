'use server'

import { eq, sql } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { PolicyError, assertCan, updateModel } from '@pm/core'
import { requireUser } from '@pm/auth'
import { getDb, schema } from '@pm/db'

type Result = { ok: true; sidecarWritten: boolean } | { ok: false; error: string }

/**
 * Saves a model's metadata.
 *
 * Everything goes through updateModel in @pm/core so the row, the search vector
 * and the on-disk sidecar always move together — doing any one of them here
 * would let them drift.
 */
export async function saveModel(
  publicId: string,
  patch: {
    name?: string
    notes?: string | null
    license?: string | null
    creator?: string | null
    tags?: string[]
    previewFileId?: string | null
  },
): Promise<Result> {
  try {
    const user = await requireUser()
    assertCan({ id: user.id, role: user.role ?? null, banned: user.banned ?? false }, 'model:edit')

    const rows = await getDb()
      .select({ id: schema.models.id })
      .from(schema.models)
      .where(eq(schema.models.publicId, publicId))
      .limit(1)

    const model = rows[0]
    if (!model) return { ok: false, error: 'That model no longer exists.' }

    const result = await updateModel(getDb(), model.id, patch)
    if (!result.ok) return { ok: false, error: result.error ?? 'Could not save.' }

    revalidatePath(`/models/${publicId}`)
    revalidatePath('/models')
    return { ok: true, sidecarWritten: result.sidecarWritten }
  } catch (error) {
    if (error instanceof PolicyError) return { ok: false, error: 'Not permitted.' }
    return { ok: false, error: 'Could not save the changes.' }
  }
}

/** Existing tag and creator names, for autocomplete. */
export async function loadSuggestions(): Promise<{ tags: string[]; creators: string[] }> {
  try {
    await requireUser()
  } catch {
    return { tags: [], creators: [] }
  }

  const db = getDb()
  const [tags, creators] = await Promise.all([
    db.execute<{ name: string }>(
      // Most-used first: those are the ones worth suggesting.
      sql`SELECT t.name FROM tags t
          LEFT JOIN model_tags mt ON mt.tag_id = t.id
          GROUP BY t.id, t.name ORDER BY count(mt.model_id) DESC, t.name ASC LIMIT 200`,
    ),
    db.execute<{ name: string }>(
      sql`SELECT c.name FROM creators c
          LEFT JOIN models m ON m.creator_id = c.id
          GROUP BY c.id, c.name ORDER BY count(m.id) DESC, c.name ASC LIMIT 200`,
    ),
  ])

  return {
    tags: tags.rows.map((row) => row.name),
    creators: creators.rows.map((row) => row.name),
  }
}
