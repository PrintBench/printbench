import { sql } from 'drizzle-orm'
import type { Database } from '@pm/db'
import {
  COSMETIC_KINDS,
  PROBLEM_META,
  type Problem,
  type ProblemCount,
  type ProblemKind,
  type ProblemSeverity,
} from './problem-kinds'

export * from './problem-kinds'

export interface DetectOptions {
  /** Limit to one library. Absent means the whole instance. */
  libraryId?: string
  /**
   * Skip the metadata-completeness kinds. A library nobody has curated yet
   * would otherwise raise four problems per model on its first scan, which
   * buries the ones that matter.
   */
  skipCosmetic?: boolean
}

export interface DetectResult {
  raised: number
  resolved: number
  byKind: Partial<Record<ProblemKind, number>>
}

/**
 * Runs every detector, raising what is now true and resolving what no longer is.
 *
 * Safe to run repeatedly: the partial unique index on open problems makes the
 * inserts idempotent, so this can go on a schedule and after every scan.
 */
export async function detectProblems(
  db: Database,
  options: DetectOptions = {},
): Promise<DetectResult> {
  const kinds = Object.keys(PROBLEM_META) as ProblemKind[]
  const active = options.skipCosmetic
    ? kinds.filter((kind) => !COSMETIC_KINDS.includes(kind))
    : kinds

  const byKind: Partial<Record<ProblemKind, number>> = {}
  let raised = 0

  for (const kind of active) {
    const count = await raise(db, kind, options.libraryId)
    if (count > 0) byKind[kind] = count
    raised += count
  }

  const resolved = await resolveStale(db, active, options.libraryId)
  return { raised, resolved, byKind }
}

/** The subject of each detector, as a query yielding (model_id, model_file_id, detail). */
function detector(kind: ProblemKind, libraryId?: string) {
  // Applied inside each detector rather than around them: the joins differ.
  const lib = libraryId ? sql`AND m.library_id = ${libraryId}` : sql``

  switch (kind) {
    case 'missing':
      return sql`
        SELECT m.id AS id, NULL::uuid AS file_id,
               jsonb_build_object('missingAt', m.missing_at) AS detail
        FROM models m WHERE m.missing_at IS NOT NULL ${lib}`

    case 'empty':
      return sql`
        SELECT m.id AS id, NULL::uuid AS file_id, '{}'::jsonb AS detail
        FROM models m
        WHERE m.missing_at IS NULL AND m.file_count = 0 ${lib}`

    /*
     * Reported against the file, not the model, and only for the copies after
     * the first — otherwise every duplicate pair produces two entries saying
     * the same thing about each other.
     */
    case 'duplicate_digest':
      return sql`
        SELECT f.model_id AS id, f.id AS file_id,
               jsonb_build_object('digest', f.digest, 'copies', d.copies) AS detail
        FROM model_files f
        JOIN models m ON m.id = f.model_id
        JOIN (
          SELECT digest, count(*) AS copies, min(id::text) AS keep
          FROM model_files
          WHERE digest IS NOT NULL AND missing_at IS NULL
          GROUP BY digest HAVING count(*) > 1
        ) d ON d.digest = f.digest
        WHERE f.missing_at IS NULL AND f.id::text <> d.keep ${lib}`

    case 'no_license':
      return sql`
        SELECT m.id AS id, NULL::uuid AS file_id, '{}'::jsonb AS detail
        FROM models m
        WHERE m.missing_at IS NULL AND (m.license IS NULL OR m.license = '') ${lib}`

    case 'no_creator':
      return sql`
        SELECT m.id AS id, NULL::uuid AS file_id, '{}'::jsonb AS detail
        FROM models m
        WHERE m.missing_at IS NULL AND m.creator_id IS NULL ${lib}`

    /*
     * No supplied image AND nothing we managed to render. Either alone is
     * fine — a rendered thumbnail is a perfectly good preview.
     */
    case 'no_image':
      return sql`
        SELECT m.id AS id, NULL::uuid AS file_id, '{}'::jsonb AS detail
        FROM models m
        WHERE m.missing_at IS NULL ${lib}
          AND NOT EXISTS (
            SELECT 1 FROM model_files f
            WHERE f.model_id = m.id AND f.missing_at IS NULL
              AND (f.category = 'image' OR f.thumb_state = 'ok'))`

    case 'no_tags':
      return sql`
        SELECT m.id AS id, NULL::uuid AS file_id, '{}'::jsonb AS detail
        FROM models m
        WHERE m.missing_at IS NULL ${lib}
          AND NOT EXISTS (SELECT 1 FROM model_tags mt WHERE mt.model_id = m.id)`

    /*
     * A model whose folder sits inside another model's folder, in the same
     * library. The separator matters: without it "Dragon" would look like the
     * parent of "Dragonborn".
     */
    case 'nested_model':
      return sql`
        SELECT child.id AS id, NULL::uuid AS file_id,
               jsonb_build_object('parentPath', parent.path, 'parentId', parent.id) AS detail
        FROM models child
        JOIN models parent
          ON parent.library_id = child.library_id
         AND parent.id <> child.id
         AND parent.missing_at IS NULL
         AND child.path LIKE parent.path || '/%'
        JOIN models m ON m.id = child.id
        WHERE child.missing_at IS NULL AND NOT child.is_file_model ${lib}`

    case 'unparseable':
      /*
       * The parser's own reason is carried through, not just the two state
       * columns. "analysis failed, thumbnail failed" says only that something
       * went wrong; the recorded message says what — a truncated file, or one
       * whose geometry could not be a real object — which is the difference
       * between a report someone can act on and one they cannot.
       */
      return sql`
        SELECT f.model_id AS id, f.id AS file_id,
               jsonb_build_object(
                 'analysis', f.analysis_state,
                 'thumbnail', f.thumb_state,
                 'reason', coalesce(f.analysis_error, f.thumb_error)
               ) AS detail
        FROM model_files f
        JOIN models m ON m.id = f.model_id
        WHERE f.missing_at IS NULL AND f.previewable
          AND (f.analysis_state = 'failed' OR f.thumb_state = 'failed') ${lib}`
  }
}

async function raise(db: Database, kind: ProblemKind, libraryId?: string): Promise<number> {
  const result = await db.execute(sql`
    INSERT INTO problems (kind, severity, model_id, model_file_id, detail)
    SELECT ${kind}::problem_kind, ${PROBLEM_META[kind].severity}::problem_severity,
           d.id, d.file_id, d.detail
    FROM (${detector(kind, libraryId)}) d
    -- The partial unique index covers open problems only, so a fixed-then-
    -- broken-again subject is raised afresh rather than silently swallowed.
    ON CONFLICT DO NOTHING
  `)
  return result.rowCount ?? 0
}

/**
 * Closes open problems whose condition no longer holds.
 *
 * Resolved rather than deleted: the row is the record that something was once
 * wrong, and deleting it would let the same problem be raised and cleared
 * repeatedly with no trace.
 */
async function resolveStale(
  db: Database,
  kinds: ProblemKind[],
  libraryId?: string,
): Promise<number> {
  let resolved = 0

  for (const kind of kinds) {
    const result = await db.execute(sql`
      UPDATE problems p SET resolved_at = now()
      WHERE p.kind = ${kind}::problem_kind
        AND p.resolved_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM (${detector(kind, libraryId)}) d
          WHERE d.id IS NOT DISTINCT FROM p.model_id
            AND d.file_id IS NOT DISTINCT FROM p.model_file_id
        )
        ${
          /*
           * Scoped to the library being examined. Without this, a per-library
           * detection would resolve every other library's problems, because
           * their subjects are not in this detector's output.
           */
          libraryId
            ? sql`AND (p.model_id IS NULL OR EXISTS (
                    SELECT 1 FROM models m
                    WHERE m.id = p.model_id AND m.library_id = ${libraryId}))`
            : sql``
        }
    `)
    resolved += result.rowCount ?? 0
  }

  return resolved
}

export interface ListProblemOptions {
  kind?: ProblemKind
  severity?: ProblemSeverity
  libraryId?: string
  /** Ignored problems are hidden unless asked for. */
  includeIgnored?: boolean
  limit?: number
  offset?: number
}

export async function listProblems(
  db: Database,
  options: ListProblemOptions = {},
): Promise<Problem[]> {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500)

  const conditions = [
    sql`p.resolved_at IS NULL`,
    options.includeIgnored ? null : sql`p.ignored_at IS NULL`,
    options.kind ? sql`p.kind = ${options.kind}::problem_kind` : null,
    options.severity ? sql`p.severity = ${options.severity}::problem_severity` : null,
    options.libraryId ? sql`m.library_id = ${options.libraryId}` : null,
  ].filter(Boolean) as ReturnType<typeof sql>[]

  const rows = await db.execute<{
    id: string
    kind: ProblemKind
    severity: ProblemSeverity
    model_id: string | null
    model_name: string | null
    model_public_id: string | null
    model_file_id: string | null
    filename: string | null
    library_name: string | null
    detail: unknown
    created_at: string
    ignored_at: string | null
  }>(sql`
    SELECT p.id, p.kind, p.severity, p.model_id, m.name AS model_name,
           m.public_id AS model_public_id, p.model_file_id, f.filename,
           l.name AS library_name, p.detail, p.created_at, p.ignored_at
    FROM problems p
    LEFT JOIN models m ON m.id = p.model_id
    LEFT JOIN libraries l ON l.id = m.library_id
    LEFT JOIN model_files f ON f.id = p.model_file_id
    WHERE ${sql.join(conditions, sql` AND `)}
    -- Worst first, then oldest: severity is an enum in that order.
    ORDER BY p.severity DESC, p.created_at ASC, p.id
    LIMIT ${limit} OFFSET ${Math.max(options.offset ?? 0, 0)}
  `)

  return rows.rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    severity: row.severity,
    modelId: row.model_id,
    modelName: row.model_name,
    modelPublicId: row.model_public_id,
    modelFileId: row.model_file_id,
    filename: row.filename,
    libraryName: row.library_name,
    detail: row.detail,
    createdAt: new Date(row.created_at),
    ignoredAt: row.ignored_at ? new Date(row.ignored_at) : null,
  }))
}

/** Open counts per kind, for the dashboard's summary tiles. */
export async function problemSummary(
  db: Database,
  libraryId?: string,
): Promise<ProblemCount[]> {
  const rows = await db.execute<{
    kind: ProblemKind
    severity: ProblemSeverity
    open: number
    ignored: number
  }>(sql`
    SELECT p.kind, p.severity,
           count(*) FILTER (WHERE p.ignored_at IS NULL)::int AS open,
           count(*) FILTER (WHERE p.ignored_at IS NOT NULL)::int AS ignored
    FROM problems p
    ${libraryId ? sql`JOIN models m ON m.id = p.model_id` : sql``}
    WHERE p.resolved_at IS NULL
      ${libraryId ? sql`AND m.library_id = ${libraryId}` : sql``}
    GROUP BY p.kind, p.severity
    ORDER BY p.severity DESC, count(*) DESC
  `)
  return rows.rows
}

/**
 * Hides problems without claiming they were fixed.
 *
 * The distinction is the point: a model with no licence because it genuinely
 * has none is not a fault to be corrected, but it will be re-raised on every
 * scan unless it can be dismissed. Ignored problems stay open, so the detector
 * still sees them and does not raise duplicates.
 */
export async function ignoreProblems(db: Database, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0
  const result = await db.execute(sql`
    UPDATE problems SET ignored_at = now()
    WHERE id = ANY(${sql.param(ids)}::uuid[]) AND resolved_at IS NULL`)
  return result.rowCount ?? 0
}

export async function unignoreProblems(db: Database, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0
  const result = await db.execute(sql`
    UPDATE problems SET ignored_at = NULL WHERE id = ANY(${sql.param(ids)}::uuid[])`)
  return result.rowCount ?? 0
}

/**
 * Marks problems resolved by hand.
 *
 * Rarely needed — detectors resolve their own — but a problem whose subject was
 * deleted outright, or one whose detector was switched off, would otherwise sit
 * open forever.
 */
export async function resolveProblems(db: Database, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0
  const result = await db.execute(sql`
    UPDATE problems SET resolved_at = now()
    WHERE id = ANY(${sql.param(ids)}::uuid[]) AND resolved_at IS NULL`)
  return result.rowCount ?? 0
}

/** Ignores every open problem of one kind — "I do not track licences". */
export async function ignoreKind(db: Database, kind: ProblemKind): Promise<number> {
  const result = await db.execute(sql`
    UPDATE problems SET ignored_at = now()
    WHERE kind = ${kind}::problem_kind AND resolved_at IS NULL AND ignored_at IS NULL`)
  return result.rowCount ?? 0
}
