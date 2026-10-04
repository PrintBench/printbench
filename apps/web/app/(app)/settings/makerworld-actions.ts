'use server'

import { requireUser } from '@pb/auth'
import {
  assertCan,
  PolicyError,
  MakerWorldImportError,
  getMakerWorldCookieStatus,
  saveMakerWorldCookie,
  startMakerWorldSignIn,
  verifyMakerWorldSignIn,
  cancelMakerWorldSignIn,
  checkMakerWorldConnection,
  BambuSignInError,
  MakerWorldChallengeError,
  type MakerWorldSignInStatus,
  type MakerWorldConnectionState,
} from '@pb/core'
import { getDb } from '@pb/db'

type Failure = { ok: false; error: string; retryChallengeId?: string; restart?: boolean }

async function authorize() {
  const user = await requireUser()
  assertCan({ id: user.id, role: user.role ?? null, banned: user.banned ?? false }, 'file:upload')
  return user
}

// Never return arbitrary service errors: credential failures may contain secrets.
function failure(error: unknown, message: string): Failure {
  if (error instanceof MakerWorldChallengeError)
    return {
      ok: false,
      error: error.message,
      ...(error.retryChallengeId
        ? { retryChallengeId: error.retryChallengeId }
        : { restart: true }),
    }
  if (error instanceof BambuSignInError) return { ok: false, error: error.message }
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
    await cancelMakerWorldSignIn(getDb(), user.id)
    await saveMakerWorldCookie(getDb(), user.id, cookie)
    return { ok: true, saved: await getMakerWorldCookieStatus(getDb(), user.id) }
  } catch (error) {
    return failure(error, 'Could not save your MakerWorld cookie. Check its value and try again.')
  }
}

export async function connectMakerWorld(input: {
  email: string
  password: string
}): Promise<{ ok: true; status: MakerWorldSignInStatus } | Failure> {
  try {
    const user = await authorize()
    return {
      ok: true,
      status: await startMakerWorldSignIn(getDb(), user.id, input.email, input.password),
    }
  } catch (error) {
    return failure(error, 'Could not sign in to Bambu. Please try again.')
  }
}

export async function verifyMakerWorldConnection(input: {
  challengeId: string
  code: string
}): Promise<{ ok: true; status: MakerWorldSignInStatus } | Failure> {
  try {
    const user = await authorize()
    return {
      ok: true,
      status: await verifyMakerWorldSignIn(getDb(), user.id, input.challengeId, input.code),
    }
  } catch (error) {
    const result = failure(error, 'Could not finish sign-in. Start again and retry.')
    return error instanceof BambuSignInError ||
      error instanceof MakerWorldChallengeError ||
      error instanceof PolicyError
      ? result
      : { ...result, restart: true }
  }
}

export async function cancelMakerWorldConnection(): Promise<{ ok: true } | Failure> {
  try {
    const user = await authorize()
    await cancelMakerWorldSignIn(getDb(), user.id)
    return { ok: true }
  } catch (error) {
    return failure(error, 'Could not cancel sign-in. Please try again.')
  }
}

export async function testMakerWorldConnection(): Promise<
  { ok: true; state: MakerWorldConnectionState } | Failure
> {
  try {
    const user = await authorize()
    return { ok: true, state: await checkMakerWorldConnection(getDb(), user.id) }
  } catch (error) {
    return failure(error, 'Could not check the connection. Please try again.')
  }
}
