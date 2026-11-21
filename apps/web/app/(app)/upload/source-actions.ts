'use server'

import { requireUser } from '@pb/auth'
import { assertCan, PolicyError, MakerWorldImportError, getMakerWorldImportStatus } from '@pb/core'
import { getDb } from '@pb/db'
import { ModelImportQueueError, submitModelSourceImport } from '@/lib/model-source-import'

type Failure = { ok: false; error: string }
export interface MakerWorldImportStatus {
  state: 'queued' | 'importing' | 'complete' | 'failed'
  publicId: string | null
  error: string | null
}

async function authorize() {
  const user = await requireUser()
  assertCan({ id: user.id, role: user.role ?? null, banned: user.banned ?? false }, 'file:upload')
  return user
}

// Never return arbitrary service errors: upstream failures can contain credentials.
function failure(error: unknown, message: string): Failure {
  if (error instanceof PolicyError) return { ok: false, error: 'Not permitted.' }
  if (error instanceof MakerWorldImportError || error instanceof ModelImportQueueError) {
    return { ok: false, error: error.message }
  }
  return { ok: false, error: message }
}

export async function startModelSourceImport(input: {
  libraryId: string
  url: string
}): Promise<{ ok: true; id: string } | Failure> {
  try {
    const user = await authorize()
    const created = await submitModelSourceImport(user, input)
    return { ok: true, id: created.id }
  } catch (error) {
    return failure(error, 'Could not start the import. Check the model URL and writable library.')
  }
}

export async function pollMakerWorldImport(
  id: string,
): Promise<{ ok: true; status: MakerWorldImportStatus } | Failure> {
  try {
    const user = await authorize()
    const status = await getMakerWorldImportStatus(getDb(), user.id, id)
    if (!status) return { ok: false, error: 'That import was not found.' }
    return { ok: true, status }
  } catch (error) {
    return failure(error, 'Could not check the import. Try checking again.')
  }
}
