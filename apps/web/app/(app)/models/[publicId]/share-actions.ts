'use server'

import { eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { headers } from 'next/headers'
import {
  PolicyError,
  assertCan,
  getSettings,
  shareModel,
  unshareModel,
} from '@pm/core'
import { requireUser } from '@pm/auth'
import { getDb, schema } from '@pm/db'

type ShareResult =
  | { ok: true; url: string }
  | { ok: false; error: string; sharingDisabled?: boolean }

async function modelIdFor(publicId: string): Promise<string | null> {
  const rows = await getDb()
    .select({ id: schema.models.id })
    .from(schema.models)
    .where(eq(schema.models.publicId, publicId))
    .limit(1)
  return rows[0]?.id ?? null
}

/**
 * Creates (or returns) the share link for a model.
 *
 * Sharing is a per-model act gated by an instance-wide switch. Both have to be
 * on — an admin who turns sharing off closes every existing link at once, which
 * is the control you want when something has been posted somewhere it should
 * not have been.
 */
export async function createShareLink(publicId: string): Promise<ShareResult> {
  try {
    const user = await requireUser()
    // Sharing a model publicly is an editing decision, not a viewing one.
    assertCan({ id: user.id, role: user.role ?? null, banned: user.banned ?? false }, 'model:edit')

    const { publicSharing } = await getSettings(getDb())
    if (!publicSharing) {
      return {
        ok: false,
        error: 'Share links are turned off for this instance.',
        sharingDisabled: true,
      }
    }

    const modelId = await modelIdFor(publicId)
    if (!modelId) return { ok: false, error: 'That model no longer exists.' }

    const { token } = await shareModel(getDb(), modelId, user.id)

    revalidatePath(`/models/${publicId}`)
    return { ok: true, url: `${await origin()}/share/${token}` }
  } catch (error) {
    if (error instanceof PolicyError) return { ok: false, error: 'Not permitted.' }
    return { ok: false, error: 'Could not create the link.' }
  }
}

export async function revokeShareLink(publicId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const user = await requireUser()
    assertCan({ id: user.id, role: user.role ?? null, banned: user.banned ?? false }, 'model:edit')

    const modelId = await modelIdFor(publicId)
    if (!modelId) return { ok: false, error: 'That model no longer exists.' }

    await unshareModel(getDb(), modelId)
    revalidatePath(`/models/${publicId}`)
    return { ok: true }
  } catch (error) {
    if (error instanceof PolicyError) return { ok: false, error: 'Not permitted.' }
    return { ok: false, error: 'Could not revoke the link.' }
  }
}

/** The link has to work outside this browser, so it must be absolute. */
async function origin(): Promise<string> {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/+$/, '')
  const headerList = await headers()
  const host = headerList.get('x-forwarded-host') ?? headerList.get('host') ?? 'localhost:3000'
  const proto = headerList.get('x-forwarded-proto') ?? 'http'
  return `${proto}://${host}`
}
