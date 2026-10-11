'use server'

import { requireUser } from '@pb/auth'
import {
  assertCan,
  PolicyError,
  MakerWorldImportError,
  markMakerWorldImportQueueFailed,
  createModelSourceImport,
  getMakerWorldImportStatus,
} from '@pb/core'
import { getDb } from '@pb/db'
import { getStartedQueue, JOB } from '@pb/jobs'
import { audit } from '@/lib/audit'

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

export async function startModelSourceImport(input: {
  libraryId: string
  url: string
}): Promise<{ ok: true; id: string } | Failure> {
  try {
    const user = await authorize()
    const created = await createModelSourceImport(getDb(), {
      userId: user.id,
      libraryId: input.libraryId,
      url: input.url,
    })
    try {
      const queue = await getStartedQueue()
      // One active delivery per request; a second click only follows that job.
      const job = await queue.send(
        JOB.makerWorldImport,
        { importId: created.id },
        { singletonKey: `import:${created.id}` },
      )
      if (!job) {
        const status = await getMakerWorldImportStatus(getDb(), user.id, created.id)
        if (
          status?.state === 'queued' ||
          status?.state === 'importing' ||
          status?.state === 'complete'
        ) {
          return { ok: true, id: created.id }
        }
        throw new Error('Queue unavailable')
      }
    } catch {
      await markMakerWorldImportQueueFailed(getDb(), user.id, created.id)
      return { ok: false, error: 'Could not queue the import. Please try again.' }
    }
    await audit(user, 'model.imported', {
      type: 'import',
      id: created.id,
      label: sourceHost(input.url),
    })
    return { ok: true, id: created.id }
  } catch (error) {
    return failure(error, 'Could not start the import. Check the model URL and writable library.')
  }
}

/** Where it came from, without the path: enough to recognise, nothing to leak. */
function sourceHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return 'a model site'
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
