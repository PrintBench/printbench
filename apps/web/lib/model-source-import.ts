import {
  createModelSourceImport,
  getMakerWorldImportStatus,
  markMakerWorldImportQueueFailed,
} from '@pb/core'
import { getDb } from '@pb/db'
import { getStartedQueue, JOB } from '@pb/jobs'
import { audit } from '@/lib/audit'

export class ModelImportQueueError extends Error {
  constructor() {
    super('Could not queue the import. Please try again.')
  }
}

export async function submitModelSourceImport(
  user: { id: string; name?: string | null },
  input: { libraryId: string; url: string },
): Promise<{ id: string }> {
  const db = getDb()
  const created = await createModelSourceImport(db, {
    userId: user.id,
    libraryId: input.libraryId,
    url: input.url,
  })
  try {
    const queue = await getStartedQueue()
    const job = await queue.send(
      JOB.makerWorldImport,
      { importId: created.id },
      { singletonKey: 'import:' + created.id },
    )
    if (!job) {
      const status = await getMakerWorldImportStatus(db, user.id, created.id)
      if (
        status?.state === 'queued' ||
        status?.state === 'importing' ||
        status?.state === 'complete'
      ) {
        return created
      }
      throw new ModelImportQueueError()
    }
  } catch {
    await markMakerWorldImportQueueFailed(db, user.id, created.id)
    throw new ModelImportQueueError()
  }
  await audit(user, 'model.imported', {
    type: 'import',
    id: created.id,
    label: new URL(input.url).hostname.replace(/^www\./, ''),
  })
  return created
}
