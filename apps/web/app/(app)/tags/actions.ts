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
import { eq } from 'drizzle-orm'
import type { AuditAction } from '@pb/core'
import { getDb, schema } from '@pb/db'
import { audit } from '@/lib/audit'

type Result = { ok: true; count?: number } | { ok: false; error: string }

async function requireTagEditor() {
  const user = await requireUser()
  assertCan({ id: user.id, role: user.role ?? null, banned: user.banned ?? false }, 'tag:edit')
  return user
}

async function tagName(tagId: string): Promise<string | undefined> {
  const rows = await getDb()
    .select({ name: schema.tags.name })
    .from(schema.tags)
    .where(eq(schema.tags.id, tagId))
    .limit(1)
  return rows[0]?.name
}

/**
 * Every one of these changes tag names, which are weighted into the search
 * vector — so the service layer rebuilds the affected models' vectors. Doing it
 * here instead would mean remembering it at four call sites.
 *
 * `record` names the tag before the work runs: afterwards it may be gone.
 */
async function act(
  work: () => Promise<number | void>,
  failure: string,
  record: { action: AuditAction; tagId: string; detail?: () => Promise<Record<string, unknown>> },
): Promise<Result> {
  try {
    const user = await requireTagEditor()
    const label = await tagName(record.tagId)
    const detail = await record.detail?.()
    const count = await work()
    await audit(
      user,
      record.action,
      { type: 'tag', id: record.tagId, label },
      { ...detail, ...(typeof count === 'number' ? { models: count } : {}) },
    )

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
  return act(() => renameTag(getDb(), tagId, name), 'Could not rename that tag.', {
    action: 'tag.updated',
    tagId,
    detail: async () => ({ renamedTo: name.trim() }),
  })
}

export async function merge(fromId: string, intoId: string): Promise<Result> {
  return act(() => mergeTags(getDb(), fromId, intoId), 'Could not merge those tags.', {
    action: 'tag.merged',
    tagId: fromId,
    detail: async () => ({ into: (await tagName(intoId)) ?? intoId }),
  })
}

export async function recolour(tagId: string, color: string | null): Promise<Result> {
  return act(() => setTagColor(getDb(), tagId, color), 'Could not set that colour.', {
    action: 'tag.updated',
    tagId,
    detail: async () => ({ colour: color ?? 'none' }),
  })
}

export async function remove(tagId: string): Promise<Result> {
  return act(() => deleteTag(getDb(), tagId), 'Could not remove that tag.', {
    action: 'tag.deleted',
    tagId,
  })
}
