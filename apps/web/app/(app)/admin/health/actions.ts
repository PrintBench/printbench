'use server'

import { revalidatePath } from 'next/cache'
import {
  PolicyError,
  assertCan,
  detectProblems,
  ignoreKind,
  ignoreProblems,
  resolveProblems,
  unignoreProblems,
  type ProblemKind,
} from '@pm/core'
import { requireUser } from '@pm/auth'
import { getDb } from '@pm/db'

type Result = { ok: true; count?: number } | { ok: false; error: string }

async function requirePermission() {
  const user = await requireUser()
  assertCan(
    { id: user.id, role: user.role ?? null, banned: user.banned ?? false },
    'problem:resolve',
  )
}

/** UUIDs only: these ids go straight into an `= ANY(...)` array parameter. */
function clean(ids: string[]): string[] {
  return ids.filter((id) => /^[0-9a-f-]{36}$/i.test(id)).slice(0, 500)
}

export async function ignore(ids: string[]): Promise<Result> {
  return act(() => ignoreProblems(getDb(), clean(ids)), 'Could not ignore those.')
}

export async function unignore(ids: string[]): Promise<Result> {
  return act(() => unignoreProblems(getDb(), clean(ids)), 'Could not restore those.')
}

export async function resolve(ids: string[]): Promise<Result> {
  return act(() => resolveProblems(getDb(), clean(ids)), 'Could not resolve those.')
}

export async function ignoreWholeKind(kind: ProblemKind): Promise<Result> {
  return act(() => ignoreKind(getDb(), kind), 'Could not ignore that kind.')
}

/**
 * Re-examines everything on demand.
 *
 * Runs inline rather than on the queue: it is nine statements over indexed
 * columns, and someone who presses "Check again" wants the page to come back
 * with the answer, not a job id.
 */
export async function recheck(): Promise<Result> {
  return act(async () => {
    const result = await detectProblems(getDb())
    return result.raised + result.resolved
  }, 'Could not re-examine the library.')
}

async function act(work: () => Promise<number>, failure: string): Promise<Result> {
  try {
    await requirePermission()
    const count = await work()
    revalidatePath('/admin/health')
    revalidatePath('/')
    return { ok: true, count }
  } catch (error) {
    if (error instanceof PolicyError) return { ok: false, error: 'Not permitted.' }
    console.error('[health]', error)
    return { ok: false, error: failure }
  }
}
