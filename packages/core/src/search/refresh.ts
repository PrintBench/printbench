import { sql } from 'drizzle-orm'
import type { Database } from '@pm/db'

/**
 * Search vector maintenance.
 *
 * Deliberately NOT a generated column: generated columns may only reference
 * their own row, and the things people actually search by — creator name, tags,
 * filenames — live in joined tables. Deliberately not triggers either; spreading
 * this across five tables' triggers is unmaintainable. Instead every mutation
 * path calls this, in the same transaction, batched by id.
 *
 * Weighting:
 *   A  model name        — what people usually mean
 *   B  creator, tags     — strong secondary signals
 *   C  notes             — descriptive prose
 *   D  filenames         — last resort, but genuinely useful ("presupported")
 */

/**
 * Filenames must be split before tokenising. Postgres's default parser treats
 * "presupported/dragon_body.stl" as a single `file` token, so searching for
 * "presupported" would never match it. Verified with ts_debug.
 */
const SPLIT_NON_ALNUM = `regexp_replace(%s, '[^[:alnum:]]+', ' ', 'g')`

/**
 * Note `sql.param(modelIds)`: a bare `${modelIds}` in a drizzle template is
 * spread into `($1, $2, ...)`, which Postgres reads as a record and refuses to
 * cast to uuid[]. `sql.param` passes it as one array parameter.
 */
export async function refreshModelSearchVectors(db: Database, modelIds: string[]): Promise<void> {
  if (modelIds.length === 0) return

  await db.execute(sql`
    UPDATE models m SET search_vector =
        setweight(to_tsvector('pm_search', coalesce(m2.name, '')),  'A')
     || setweight(to_tsvector('pm_search', coalesce(c.name, '')),   'B')
     || setweight(to_tsvector('pm_search', coalesce(t.tags, '')),   'B')
     || setweight(to_tsvector('pm_search', coalesce(m2.notes, '')), 'C')
     || setweight(to_tsvector('pm_search',
          regexp_replace(coalesce(f.names, ''), '[^[:alnum:]]+', ' ', 'g')), 'D')
    FROM models m2
    LEFT JOIN creators c ON c.id = m2.creator_id
    LEFT JOIN LATERAL (
      SELECT string_agg(tg.name, ' ') AS tags
      FROM model_tags mt JOIN tags tg ON tg.id = mt.tag_id
      WHERE mt.model_id = m2.id
    ) t ON true
    LEFT JOIN LATERAL (
      SELECT string_agg(mf.filename, ' ') AS names
      FROM model_files mf
      WHERE mf.model_id = m2.id AND mf.missing_at IS NULL
    ) f ON true
    WHERE m.id = m2.id
      AND m.id = ANY(${sql.param(modelIds)}::uuid[])
  `)
}

/** Nightly full rebuild. Cheap insurance against drift; batched to bound memory. */
export async function rebuildAllSearchVectors(db: Database, batchSize = 500): Promise<number> {
  let total = 0
  for (;;) {
    const rows = await db.execute<{ id: string }>(sql`
      SELECT id FROM models
      WHERE search_vector IS NULL OR indexed_at IS NULL OR indexed_at < updated_at
      LIMIT ${batchSize}
    `)
    const ids = rows.rows.map((r) => r.id)
    if (ids.length === 0) break
    await refreshModelSearchVectors(db, ids)
    total += ids.length
  }
  return total
}

export { SPLIT_NON_ALNUM }
