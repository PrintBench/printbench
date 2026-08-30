'use server'

import { revalidatePath } from 'next/cache'
import {
  PolicyError,
  RequestValidationError,
  assertCan,
  can,
  createRequest,
  createRequests,
  deleteRequest,
  getRequest,
  linkRequest,
  parseRequestLines,
  quickSearch,
  setRequestStatus,
  updateRequest,
  type PrintRequest,
  type PrintRequestPriority,
  type PrintRequestStatus,
  type RequestPatch,
} from '@pb/core'
import { requireUser } from '@pb/auth'
import { getDb } from '@pb/db'

type Result = { ok: true } | { ok: false; error: string }

type AddResult =
  | { ok: true; created: number; autoLinked: number; skipped: string[] }
  | { ok: false; error: string }

/**
 * Two levels of write.
 *
 * `edit` is the author's own request — their wording, their quantity, and
 * their decision to call it off. `run` is working the queue: starting
 * something and marking it done, which is a claim about the printer and
 * belongs to whoever is standing at it.
 */
type Need = 'edit' | 'run'

type Authorized =
  { ok: false; error: string } | { ok: true; user: { id: string }; request: PrintRequest }

async function authorize(requestId: string, need: Need): Promise<Authorized> {
  const user = await requireUser()
  const policyUser = { id: user.id, role: user.role ?? null, banned: user.banned ?? false }

  const request = await getRequest(getDb(), requestId)
  if (!request) return { ok: false, error: 'That request is no longer in the queue.' }

  const manager = can(policyUser, 'request:manage')
  if (!manager && (need === 'run' || request.createdBy !== user.id)) {
    throw new PolicyError('request:manage')
  }

  return { ok: true, user, request }
}

/**
 * Adds a whole message at once.
 *
 * The bulk box is the reason this feature exists: requests arrive as "the
 * dragon, two cable clips and a phone stand", and retyping that into six
 * separate forms is exactly the friction that keeps the list on a sticky note.
 */
export async function addRequests(input: {
  text: string
  requestedBy?: string | null
  priority?: PrintRequestPriority | null
  dueAt?: string | null
  notes?: string | null
}): Promise<AddResult> {
  try {
    const user = await requireUser()
    assertCan(
      { id: user.id, role: user.role ?? null, banned: user.banned ?? false },
      'request:create',
    )

    const lines = parseRequestLines(input.text)
    if (lines.length === 0) return { ok: false, error: 'Type at least one thing to print.' }

    const requestedBy = input.requestedBy?.trim() || null

    const result = await createRequests(
      getDb(),
      lines.map((line) => ({
        title: line.title,
        quantity: line.quantity,
        requestedBy,
        /*
         * Link the row to the asker's account only when they are asking for
         * themselves. Typing someone else's name in the box does not make the
         * request theirs.
         */
        requestedByUserId: requestedBy === null || requestedBy === user.name ? user.id : null,
        priority: input.priority ?? 'normal',
        notes: input.notes ?? null,
        dueAt: input.dueAt ? new Date(input.dueAt) : null,
      })),
      user.id,
    )

    revalidatePath('/queue')
    revalidatePath('/')

    return {
      ok: true,
      created: result.created,
      autoLinked: result.autoLinked,
      skipped: result.failed.map((failure) => failure.title),
    }
  } catch (error) {
    return { ok: false, error: describe(error, 'Could not add those to the queue.') }
  }
}

/** Queues one model straight from its own page. */
export async function addModelToQueue(input: {
  modelId: string
  modelPublicId: string
  title: string
  quantity?: number
  requestedBy?: string | null
}): Promise<Result> {
  try {
    const user = await requireUser()
    assertCan(
      { id: user.id, role: user.role ?? null, banned: user.banned ?? false },
      'request:create',
    )

    const requestedBy = input.requestedBy?.trim() || null

    await createRequest(
      getDb(),
      {
        title: input.title,
        modelId: input.modelId,
        quantity: input.quantity ?? 1,
        requestedBy,
        requestedByUserId: requestedBy === null || requestedBy === user.name ? user.id : null,
      },
      user.id,
    )

    revalidatePath('/queue')
    revalidatePath('/')
    revalidatePath(`/models/${input.modelPublicId}`)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: describe(error, 'Could not add that to the queue.') }
  }
}

export async function setStatus(requestId: string, status: PrintRequestStatus): Promise<Result> {
  try {
    // Starting or finishing a print is a claim about the printer; cancelling
    // and reopening are things the person who asked may do to their own.
    const need: Need = status === 'printing' || status === 'done' ? 'run' : 'edit'

    const authorized = await authorize(requestId, need)
    if (!authorized.ok) return authorized

    await setRequestStatus(getDb(), requestId, status)
    revalidateFor(authorized.request)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: describe(error, 'Could not update that request.') }
  }
}

export async function editRequest(requestId: string, patch: RequestPatch): Promise<Result> {
  try {
    const authorized = await authorize(requestId, 'edit')
    if (!authorized.ok) return authorized

    await updateRequest(getDb(), requestId, patch)
    revalidateFor(authorized.request)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: describe(error, 'Could not save that change.') }
  }
}

/** Points a request at a model in the library, or clears the link. */
export async function setRequestModel(
  requestId: string,
  modelId: string | null,
  modelFileId: string | null = null,
): Promise<Result> {
  try {
    const authorized = await authorize(requestId, 'edit')
    if (!authorized.ok) return authorized

    await linkRequest(getDb(), requestId, modelId, modelFileId)

    /*
     * Both ends of the link move: the model page shows what is queued against
     * it, so the model it just left and the one it just joined are each stale.
     */
    revalidateFor(authorized.request)
    if (modelId) revalidateFor((await getRequest(getDb(), requestId)) ?? authorized.request)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: describe(error, 'Could not link that request.') }
  }
}

export async function removeRequest(requestId: string): Promise<Result> {
  try {
    const authorized = await authorize(requestId, 'edit')
    if (!authorized.ok) return authorized

    await deleteRequest(getDb(), requestId)
    revalidateFor(authorized.request)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: describe(error, 'Could not remove that request.') }
  }
}

export interface ModelChoice {
  id: string
  publicId: string | null
  name: string
  libraryName: string | null
}

/**
 * Models matching what someone typed into the link picker.
 *
 * Reuses the command palette's search rather than adding a second one: it is
 * already tuned for a few characters typed quickly, and a private search that
 * ranked differently from the visible one would be its own small bug.
 */
export async function findModels(query: string): Promise<ModelChoice[]> {
  const user = await requireUser()
  assertCan({ id: user.id, role: user.role ?? null, banned: user.banned ?? false }, 'model:view')

  if (query.trim().length === 0) return []

  const hits = await quickSearch(getDb(), query, 20)

  return hits
    .filter((hit) => hit.kind === 'model')
    .slice(0, 8)
    .map((hit) => ({
      id: hit.id,
      publicId: hit.publicId,
      name: hit.label,
      libraryName: hit.detail,
    }))
}

function revalidateFor(request: PrintRequest) {
  revalidatePath('/queue')
  revalidatePath('/')
  if (request.modelPublicId) revalidatePath(`/models/${request.modelPublicId}`)
}

function describe(error: unknown, fallback: string): string {
  if (error instanceof RequestValidationError) return error.message
  if (error instanceof PolicyError) return 'Not permitted.'
  console.error('[queue]', error)
  return fallback
}
