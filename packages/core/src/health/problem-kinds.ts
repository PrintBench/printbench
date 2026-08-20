
/**
 * Library health.
 *
 * A library of a few thousand models accumulates rot that nobody notices file
 * by file: a folder that lost its drive, the same model downloaded twice under
 * different names, four hundred models with no licence recorded. This turns
 * that into a list you can work through.
 *
 * Two rules shape the design:
 *
 * Every detector is one set-based statement. Walking models in a loop would be
 * thousands of round trips and would make the scan noticeably slower, for a
 * report nobody reads while it runs.
 *
 * Every detector also un-raises itself. A problem you have fixed must clear
 * without being told, or the list fills with stale entries and stops being
 * worth opening — which is how health dashboards die.
 */

export type ProblemKind =
  | 'missing'
  | 'empty'
  | 'duplicate_digest'
  | 'no_license'
  | 'no_creator'
  | 'no_image'
  | 'no_tags'
  | 'nested_model'
  | 'unparseable'

export type ProblemSeverity = 'info' | 'warning' | 'danger'

export interface Problem {
  id: string
  kind: ProblemKind
  severity: ProblemSeverity
  modelId: string | null
  modelName: string | null
  modelPublicId: string | null
  modelFileId: string | null
  filename: string | null
  libraryName: string | null
  detail: unknown
  createdAt: Date
  ignoredAt: Date | null
}

export interface ProblemCount {
  kind: ProblemKind
  severity: ProblemSeverity
  open: number
  ignored: number
}

/**
 * What each kind means, and how loudly to say it.
 *
 * `danger` is reserved for data at risk. Missing files earn it because the
 * cause is usually an unmounted drive; a missing licence does not, however
 * tidy-minded you feel — grading everything as urgent means nothing is.
 */
export const PROBLEM_META: Record<
  ProblemKind,
  { severity: ProblemSeverity; label: string; hint: string }
> = {
  missing: {
    severity: 'danger',
    label: 'Missing from disk',
    hint: 'The files were not found during the last scan. If a drive is unmounted, remount it and scan again — nothing has been deleted.',
  },
  empty: {
    severity: 'warning',
    label: 'No files',
    hint: 'The folder was indexed but holds nothing we recognise.',
  },
  unparseable: {
    severity: 'warning',
    label: 'Could not be read',
    hint: 'The mesh could not be parsed, so it has no dimensions and no thumbnail. It may be truncated.',
  },
  nested_model: {
    severity: 'warning',
    label: 'Model inside another model',
    hint: 'One model folder sits inside another. Usually the grouping mode needs changing, or the two should be merged.',
  },
  duplicate_digest: {
    severity: 'info',
    label: 'Duplicate file',
    hint: 'The same bytes appear in more than one model — often the same download saved twice.',
  },
  no_creator: {
    severity: 'info',
    label: 'No creator',
    hint: 'Recording who made it makes the creator page and the filter useful.',
  },
  no_license: {
    severity: 'info',
    label: 'No licence',
    hint: 'Worth recording before sharing or selling a print.',
  },
  no_image: {
    severity: 'info',
    label: 'No preview',
    hint: 'Nothing renders for this model, so it is a blank card in the grid.',
  },
  no_tags: {
    severity: 'info',
    label: 'No tags',
    hint: 'Untagged models are found by name only.',
  },
}

/** Kinds that are about tidiness rather than breakage. */
export const COSMETIC_KINDS: ProblemKind[] = ['no_license', 'no_creator', 'no_image', 'no_tags']

