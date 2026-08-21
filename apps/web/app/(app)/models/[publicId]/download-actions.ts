'use server'

import { createHmac } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { PolicyError, assertCan } from '@pb/core'
import { requireUser } from '@pb/auth'
import { getDb, schema } from '@pb/db'

type Result = { ok: true; url: string } | { ok: false; error: string }

/** Long enough to start a large download, short enough that a leaked URL dies. */
const TOKEN_TTL_MS = 10 * 60 * 1000

/**
 * Mints a signed link to the worker's ZIP endpoint.
 *
 * The worker builds archives because an 8 GB one occupies a thread for minutes,
 * but it has no session cookie and no auth stack — auth is a web-tier concern.
 * So authorisation happens here and is handed over as a short-lived HMAC naming
 * the model, which the worker verifies. Neither process needs to know how the
 * other authenticates.
 */
export async function createModelDownloadLink(publicId: string): Promise<Result> {
  try {
    const user = await requireUser()
    assertCan(
      { id: user.id, role: user.role ?? null, banned: user.banned ?? false },
      'file:download',
    )

    const secret = process.env.BETTER_AUTH_SECRET
    if (!secret) return { ok: false, error: 'Downloads are not configured on this server.' }

    const rows = await getDb()
      .select({ id: schema.models.id })
      .from(schema.models)
      .where(eq(schema.models.publicId, publicId))
      .limit(1)

    const model = rows[0]
    if (!model) return { ok: false, error: 'That model no longer exists.' }

    const expires = Date.now() + TOKEN_TTL_MS
    const token = createHmac('sha256', secret).update(`${model.id}:${expires}`).digest('hex')

    // Relative: nginx routes /api/download/ to the worker in production, and the
    // dev proxy does the same, so the browser never needs to know the port.
    return {
      ok: true,
      url: `/api/download/model?model=${model.id}&expires=${expires}&token=${token}`,
    }
  } catch (error) {
    if (error instanceof PolicyError) return { ok: false, error: 'Not permitted.' }
    return { ok: false, error: 'Could not prepare the download.' }
  }
}
