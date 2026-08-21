import { getDb } from '@pb/db'
import { detectProblems, getSettings } from '@pb/core'
import type { JobPayload } from '@pb/jobs'
import type { JOB } from '@pb/jobs'

/**
 * Re-examines the library for fixable problems.
 *
 * Runs after every scan and nightly. It is entirely derived from current state
 * — nothing here decides anything, it only reports — so a replayed or
 * duplicated job costs a little database time and changes nothing.
 */
export async function handleHealthDetect(
  payload: JobPayload<typeof JOB.healthDetect>,
): Promise<void> {
  const started = Date.now()
  const db = getDb()

  /*
   * An operator who has turned metadata tracking off should not have the
   * decision re-made by a caller that passed the default. Either saying so
   * wins.
   */
  const { trackMetadataProblems } = await getSettings(db)

  const result = await detectProblems(db, {
    libraryId: payload.libraryId,
    skipCosmetic: payload.skipCosmetic || !trackMetadataProblems,
  })

  const seconds = ((Date.now() - started) / 1000).toFixed(1)
  const detail = Object.entries(result.byKind)
    .map(([kind, count]) => `${kind}=${count}`)
    .join(' ')

  console.log(
    `[health] examined in ${seconds}s — ${result.raised} raised, ` +
      `${result.resolved} resolved${detail ? ` (${detail})` : ''}`,
  )
}
