'use server'

import { revalidatePath } from 'next/cache'
import { eq } from 'drizzle-orm'
import {
  BrowseError,
  PolicyError,
  addModelToCollection,
  assertCan,
  createCollection,
  deleteCollection,
  removeModelFromCollection,
  renameCollection,
} from '@pb/core'
import { requireUser } from '@pb/auth'
import { getDb, schema } from '@pb/db'
import { audit } from '@/lib/audit'

type Result = { ok: true; slug?: string } | { ok: false; error: string }

async function requireEditor() {
  const user = await requireUser()
  assertCan(
    { id: user.id, role: user.role ?? null, banned: user.banned ?? false },
    'collection:edit',
  )
  return user
}

async function collectionName(collectionId: string): Promise<string | undefined> {
  const rows = await getDb()
    .select({ name: schema.collections.name })
    .from(schema.collections)
    .where(eq(schema.collections.id, collectionId))
    .limit(1)
  return rows[0]?.name
}

export async function create(input: {
  name: string
  caption?: string | null
  parentId?: string | null
}): Promise<Result> {
  try {
    const user = await requireEditor()
    const { slug } = await createCollection(getDb(), input)
    await audit(user, 'collection.created', { type: 'collection', label: input.name.trim() })
    revalidatePath('/collections')
    return { ok: true, slug }
  } catch (error) {
    return fail(error, 'Could not create the collection.')
  }
}

export async function rename(collectionId: string, name: string): Promise<Result> {
  try {
    const user = await requireEditor()
    const before = await collectionName(collectionId)
    await renameCollection(getDb(), collectionId, name)
    await audit(
      user,
      'collection.updated',
      { type: 'collection', id: collectionId, label: before },
      { renamedTo: name.trim() },
    )
    revalidatePath('/collections')
    return { ok: true }
  } catch (error) {
    return fail(error, 'Could not rename the collection.')
  }
}

export async function remove(collectionId: string): Promise<Result> {
  try {
    const user = await requireEditor()
    const label = await collectionName(collectionId)
    // Only the grouping goes. Models and any child collections survive.
    await deleteCollection(getDb(), collectionId)
    await audit(user, 'collection.deleted', { type: 'collection', id: collectionId, label })
    revalidatePath('/collections')
    return { ok: true }
  } catch (error) {
    return fail(error, 'Could not remove the collection.')
  }
}

/** Adds or removes a model, addressed by its public id as the UI knows it. */
export async function setMembership(
  collectionId: string,
  modelPublicId: string,
  member: boolean,
): Promise<Result> {
  try {
    await requireEditor()

    const rows = await getDb()
      .select({ id: schema.models.id })
      .from(schema.models)
      .where(eq(schema.models.publicId, modelPublicId))
      .limit(1)

    const model = rows[0]
    if (!model) return { ok: false, error: 'That model no longer exists.' }

    if (member) await addModelToCollection(getDb(), collectionId, model.id)
    else await removeModelFromCollection(getDb(), collectionId, model.id)

    revalidatePath('/collections')
    revalidatePath(`/models/${modelPublicId}`)
    return { ok: true }
  } catch (error) {
    return fail(error, 'Could not update the collection.')
  }
}

function fail(error: unknown, fallback: string): Result {
  if (error instanceof BrowseError) return { ok: false, error: error.message }
  if (error instanceof PolicyError) return { ok: false, error: 'Not permitted.' }
  console.error('[collections]', error)
  return { ok: false, error: fallback }
}
