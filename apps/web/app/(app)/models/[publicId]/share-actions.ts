'use server'

import { eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { headers } from 'next/headers'
import { PolicyError, assertCan, getSettings, shareModel, unshareModel } from '@pb/core'
import { requireUser } from '@pb/auth'
import { getDb, schema } from '@pb/db'
import { audit } from '@/lib/audit'

type ShareResult =
  { ok: true; url: string } | { ok: false; error: string; sharingDisabled?: boolean }

async function modelFor(publicId: string): Promise<{ id: string; name: string } | null> {
  const rows = await getDb()
    .select({ id: schema.models.id, name: schema.models.name })
    .from(schema.models)
    .where(eq(schema.models.publicId, publicId))
    .limit(1)
  return rows[0] ?? null
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

    const model = await modelFor(publicId)
    if (!model) return { ok: false, error: 'That model no longer exists.' }

    const { token } = await shareModel(getDb(), model.id, user.id)
    await audit(user, 'model.shared', { type: 'model', id: publicId, label: model.name })

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

    const model = await modelFor(publicId)
    if (!model) return { ok: false, error: 'That model no longer exists.' }

    await unshareModel(getDb(), model.id)
    await audit(user, 'model.unshared', { type: 'model', id: publicId, label: model.name })
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
