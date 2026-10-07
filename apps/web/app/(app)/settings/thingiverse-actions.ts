'use server'

import { requireUser } from '@pb/auth'
import {
  assertCan,
  PolicyError,
  MakerWorldImportError,
  getThingiverseTokenStatus,
  saveThingiverseToken,
} from '@pb/core'
import { getDb } from '@pb/db'
import { audit } from '@/lib/audit'

type Failure = { ok: false; error: string }

async function authorize() {
  const user = await requireUser()
  assertCan({ id: user.id, role: user.role ?? null, banned: user.banned ?? false }, 'file:upload')
  return user
}

function failure(error: unknown, message: string): Failure {
  return {
    ok: false,
    error:
      error instanceof PolicyError
        ? 'Not permitted.'
        : error instanceof MakerWorldImportError
          ? error.message
          : message,
  }
}

/** Status only: the saved credential is never returned to the browser. */
export async function readThingiverseTokenStatus(): Promise<
  { ok: true; saved: boolean } | Failure
> {
  try {
    const user = await authorize()
    return { ok: true, saved: await getThingiverseTokenStatus(getDb(), user.id) }
  } catch (error) {
    return failure(error, 'Could not check your Thingiverse connection.')
  }
}

export async function setThingiverseToken(
  token: string,
): Promise<{ ok: true; saved: boolean } | Failure> {
  try {
    const user = await authorize()
    await saveThingiverseToken(getDb(), user.id, token)
    await audit(user, 'integration.connected', { type: 'integration', label: 'Thingiverse' })
    return { ok: true, saved: await getThingiverseTokenStatus(getDb(), user.id) }
  } catch (error) {
    return failure(error, 'Could not save your Thingiverse API token. Check it and try again.')
  }
}
