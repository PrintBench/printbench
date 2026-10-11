import { collectDebugReport, type DebugQueue, type DebugReport } from '@pb/core'
import { getDb } from '@pb/db'
import { JOB, getStartedQueue } from '@pb/jobs'

async function queueDepths(): Promise<DebugQueue[]> {
  const queue = await getStartedQueue()
  return Promise.all(
    Object.values(JOB).map(async (name) => ({ name, ...(await queue.stats(name)) })),
  )
}

export function buildDebugReport(): Promise<DebugReport> {
  return collectDebugReport(getDb(), {
    version: process.env.PB_VERSION ?? 'unknown',
    // Coolify and most CI systems expose the commit under one of these.
    commit: process.env.SOURCE_COMMIT ?? process.env.GIT_COMMIT ?? null,
    queues: queueDepths,
  })
}
