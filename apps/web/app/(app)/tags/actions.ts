'use server'

import { revalidatePath } from 'next/cache'
import {
  BrowseError,
  PolicyError,
  assertCan,
  deleteTag,
  mergeTags,
  renameTag,
  setTagColor,
} from '@pb/core'
import { requireUser } from '@pb/auth'
import { getDb } from '@pb/db'

type Result = { ok: true; count?: number } | { ok: false; error: string }

async function requireTagEditor() {
  const user = await requireUser()
  assertCan({ id: user.id, role: user.role ?? null, banned: user.banned ?? false }, 'tag:edit')
}

/**
 * Every one of these changes tag names, which are weighted into the search
 * vector — so the service layer rebuilds the affected models' vectors. Doing it
 * here instead would mean remembering it at four call sites.
 */
async function act(work: () => Promise<number | void>, failure: string): Promise<Result> {
  try {
    await requireTagEditor()
    const count = await work()

    revalidatePath('/tags')
    revalidatePath('/search')
    return { ok: true, count: typeof count === 'number' ? count : undefined }
  } catch (error) {
    if (error instanceof BrowseError) return { ok: false, error: error.message }
    if (error instanceof PolicyError) return { ok: false, error: 'Not permitted.' }
    console.error('[tags]', error)
    return { ok: false, error: failure }
  }
}

export async function rename(tagId: string, name: string): Promise<Result> {
  return act(() => renameTag(getDb(), tagId, name), 'Could not rename that tag.')
}

export async function merge(fromId: string, intoId: string): Promise<Result> {
  return act(() => mergeTags(getDb(), fromId, intoId), 'Could not merge those tags.')
}

export async function recolour(tagId: string, color: string | null): Promise<Result> {
  return act(() => setTagColor(getDb(), tagId, color), 'Could not set that colour.')
}

export async function remove(tagId: string): Promise<Result> {
  return act(() => deleteTag(getDb(), tagId), 'Could not remove that tag.')
}
