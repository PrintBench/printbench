'use server'

import { requireUser } from '@pb/auth'
import {
  assertCan,
  PolicyError,
  MakerWorldImportError,
  getMakerWorldCookieStatus,
  saveMakerWorldCookie,
} from '@pb/core'
import { getDb } from '@pb/db'

type Failure = { ok: false; error: string }

async function authorize() {
  const user = await requireUser()
  assertCan({ id: user.id, role: user.role ?? null, banned: user.banned ?? false }, 'file:upload')
  return user
}

// Never return arbitrary service errors: credential failures may contain secrets.
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

export async function readMakerWorldCookieStatus(): Promise<
  { ok: true; saved: boolean } | Failure
> {
  try {
    const user = await authorize()
    return { ok: true, saved: await getMakerWorldCookieStatus(getDb(), user.id) }
  } catch (error) {
    return failure(error, 'Could not check your MakerWorld connection.')
  }
}

export async function setMakerWorldCookie(
  cookie: string,
): Promise<{ ok: true; saved: boolean } | Failure> {
  try {
    const user = await authorize()
    await saveMakerWorldCookie(getDb(), user.id, cookie)
    return { ok: true, saved: await getMakerWorldCookieStatus(getDb(), user.id) }
  } catch (error) {
    return failure(error, 'Could not save your MakerWorld cookie. Check its value and try again.')
  }
}
