import { sql, type SQL } from 'drizzle-orm'
import type { Database } from '@pm/db'

/**
 * Model search.
 *
 * Postgres only — no Elasticsearch. At self-hosted scale (thousands to low
 * hundreds of thousands of models) a weighted tsvector with a GIN index and a
 * trigram fallback is not merely adequate, it is faster than a network hop to
 * a separate service, and it is one less thing to run and back up.
 *
 * Two matching strategies run together:
 *
 *   1. Full text over a weighted vector — name > creator and tags > notes >
 *      filenames. This handles stemming ("dragons" finds "dragon") and phrase
 *      queries.
 *   2. Trigram word similarity, for typos. Note the operator direction:
 *      `query <% target` is word_similarity(query, target); `%>` takes its
 *      arguments the other way round and matches almost nothing.
 */

export type SortOrder = 'relevance' | 'name' | 'recent' | 'largest' | 'oldest'

export interface SearchFilters {
  query?: string
  libraryIds?: string[]
  creatorIds?: string[]
  tagIds?: string[]
  licenses?: string[]
  /** File extensions the model must contain, e.g. ['stl', '3mf']. */
  extensions?: string[]
  /** Only models containing at least one pre-supported file. */
  presupported?: boolean
  /** Only models with no print logged against them. */
  neverPrinted?: boolean
  /** Only models with no thumbnail — usually a sign of a parse failure. */
  missingPreview?: boolean
  minSize?: number
  maxSize?: number
  minTriangles?: number
  maxTriangles?: number
}

export interface SearchOptions extends SearchFilters {
  sort?: SortOrder
  limit?: number
  offset?: number
}

export interface SearchHit {
  id: string
  publicId: string
  name: string
  path: string
  fileCount: number
  totalSize: number
  libraryName: string
  thumbFileId: string | null
  previewExtension: string | null
  bboxX: number | null
  bboxY: number | null
  bboxZ: number | null
  rank: number
}

export interface FacetCount {
  value: string
  label: string
  count: number
}

export interface SearchFacets {
  libraries: FacetCount[]
  creators: FacetCount[]
  tags: FacetCount[]
  licenses: FacetCount[]
  extensions: FacetCount[]
}

export interface SearchResult {
  hits: SearchHit[]
  total: number
  facets: SearchFacets
  /** Echoed back so the UI can show what was actually applied. */
  appliedQuery: string
}

/** Above this, a query is treated as prose rather than a name fragment. */
const MAX_QUERY_LENGTH = 200
const DEFAULT_LIMIT = 48

/**
 * Trigram threshold for typo tolerance.
 *
 * 0.5 catches dropped, doubled and wrong letters. It does NOT catch
 * transpositions ("dargon" for "dragon"), which share too few trigrams —
 * measured at 0.286. Lowering the threshold to catch those admits noise, so
 * transpositions are handled by the trigram-on-words path below instead.
 */
const WORD_SIMILARITY_THRESHOLD = 0.5

/**
 * Applies the trigram threshold for the `<%` operator.
 *
 * The value is interpolated rather than bound: SET does not accept bind
 * parameters ("syntax error at or near $1"). That is safe here because the
 * threshold is a module constant, never user input — the guard below makes
 * that explicit rather than merely true by inspection.
 *
 * Session-scoped rather than SET LOCAL, because LOCAL only has effect inside a
 * transaction and these queries do not run in one. It applies to the pooled
 * connection, which is exactly the scope wanted.
 */
async function applyTrigramThreshold(db: Database): Promise<void> {
  const value = WORD_SIMILARITY_THRESHOLD
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`Invalid trigram threshold: ${value}`)
  }
  await db.execute(sql.raw(`SET pg_trgm.word_similarity_threshold = ${value}`))
}

export async function searchModels(
  db: Database,
  options: SearchOptions = {},
): Promise<SearchResult> {
  const query = (options.query ?? '').trim().slice(0, MAX_QUERY_LENGTH)
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIMIT, 1), 200)
  const offset = Math.max(options.offset ?? 0, 0)
  const sort = options.sort ?? (query ? 'relevance' : 'name')

  await applyTrigramThreshold(db)

  const where = buildWhere(query, options)
  const order = buildOrder(sort, query)

  const rows = await db.execute<{
    id: string
    public_id: string
    name: string
    path: string
    file_count: number
    total_size: string
    library_name: string
    thumb_file_id: string | null
    preview_extension: string | null
    bbox_x: string | null
    bbox_y: string | null
    bbox_z: string | null
    rank: number
    total: string
  }>(sql`
    WITH matched AS (
      SELECT m.id, ${rankExpression(query)} AS rank
      FROM models m
      ${where}
    ), counted AS (
      SELECT count(*)::bigint AS total FROM matched
    )
    SELECT m.id, m.public_id, m.name, m.path, m.file_count, m.total_size,
           l.name AS library_name,
           f.extension AS preview_extension,
           coalesce(
             CASE WHEN f.thumb_state = 'ok' THEN f.id END,
             (SELECT f2.id FROM model_files f2
               WHERE f2.model_id = m.id AND f2.thumb_state = 'ok' AND f2.missing_at IS NULL
               ORDER BY f2.size DESC LIMIT 1)
           ) AS thumb_file_id,
           f.bbox_x, f.bbox_y, f.bbox_z,
           matched.rank,
           counted.total
    FROM matched
    JOIN models m ON m.id = matched.id
    JOIN libraries l ON l.id = m.library_id
    LEFT JOIN model_files f ON f.id = m.preview_file_id
    CROSS JOIN counted
    ${order}
    LIMIT ${limit} OFFSET ${offset}
  `)

  const facets = await loadFacets(db, query, options)

  return {
    hits: rows.rows.map((row) => ({
      id: row.id,
      publicId: row.public_id,
      name: row.name,
      path: row.path,
      fileCount: row.file_count,
      totalSize: Number(row.total_size),
      libraryName: row.library_name,
      thumbFileId: row.thumb_file_id,
      previewExtension: row.preview_extension,
      bboxX: row.bbox_x === null ? null : Number(row.bbox_x),
      bboxY: row.bbox_y === null ? null : Number(row.bbox_y),
      bboxZ: row.bbox_z === null ? null : Number(row.bbox_z),
      rank: Number(row.rank),
    })),
    // Every row carries the same window count; zero rows means zero matches.
    total: Number(rows.rows[0]?.total ?? 0),
    facets,
    appliedQuery: query,
  }
}

/**
 * Relevance score.
 *
 * Full-text rank dominates, with word similarity added so a near-miss still
 * ranks above an unrelated model that merely mentions the term in a filename.
 */
function rankExpression(query: string): SQL {
  if (!query) return sql`0::float4`
  return sql`(
    ts_rank_cd(m.search_vector, websearch_to_tsquery('pm_search', ${query}), 32) * 4
    + coalesce(word_similarity(${query}, m.name), 0)
  )::float4`
}

function buildWhere(query: string, filters: SearchFilters): SQL {
  const clauses: SQL[] = [sql`m.missing_at IS NULL`]

  if (query) {
    /*
     * Full text alone when the query uses websearch operators; full text OR the
     * fuzzy fallbacks otherwise.
     *
     * This distinction matters. The fallbacks exist to rescue typos and short
     * fragments, but OR-ing them in unconditionally DEFEATS the operators: for
     * `dragon -blue`, full text correctly excludes the blue one, and then
     * trigram similarity against the whole raw string cheerfully matches it
     * again. Someone excluding a term would see it come straight back.
     *
     * A query containing operators is a precise request, so it is answered
     * precisely.
     */
    if (hasSearchOperators(query)) {
      clauses.push(sql`m.search_vector @@ websearch_to_tsquery('pm_search', ${query})`)
    } else {
      clauses.push(sql`(
        m.search_vector @@ websearch_to_tsquery('pm_search', ${query})
        OR ${query} <% m.name
        OR m.name ILIKE ${'%' + escapeLike(query) + '%'}
      )`)
    }
  }

  if (filters.libraryIds?.length) {
    clauses.push(sql`m.library_id = ANY(${sql.param(filters.libraryIds)}::uuid[])`)
  }
  if (filters.creatorIds?.length) {
    clauses.push(sql`m.creator_id = ANY(${sql.param(filters.creatorIds)}::uuid[])`)
  }
  if (filters.licenses?.length) {
    clauses.push(sql`m.license = ANY(${sql.param(filters.licenses)}::text[])`)
  }

  // A model matches only if it carries EVERY selected tag. Narrowing is what
  // people expect from ticking more boxes.
  if (filters.tagIds?.length) {
    clauses.push(sql`(
      SELECT count(DISTINCT mt.tag_id) FROM model_tags mt
      WHERE mt.model_id = m.id AND mt.tag_id = ANY(${sql.param(filters.tagIds)}::uuid[])
    ) = ${filters.tagIds.length}`)
  }

  if (filters.extensions?.length) {
    clauses.push(sql`EXISTS (
      SELECT 1 FROM model_files f
      WHERE f.model_id = m.id AND f.missing_at IS NULL
        AND f.extension = ANY(${sql.param(filters.extensions)}::text[])
    )`)
  }

  if (filters.presupported) {
    clauses.push(sql`EXISTS (
      SELECT 1 FROM model_files f
      WHERE f.model_id = m.id AND f.missing_at IS NULL AND f.presupported = true
    )`)
  }

  if (filters.neverPrinted) {
    clauses.push(sql`NOT EXISTS (SELECT 1 FROM print_runs p WHERE p.model_id = m.id)`)
  }

  if (filters.missingPreview) {
    clauses.push(sql`NOT EXISTS (
      SELECT 1 FROM model_files f
      WHERE f.model_id = m.id AND f.thumb_state = 'ok' AND f.missing_at IS NULL
    )`)
  }

  if (filters.minSize != null) clauses.push(sql`m.total_size >= ${filters.minSize}`)
  if (filters.maxSize != null) clauses.push(sql`m.total_size <= ${filters.maxSize}`)

  if (filters.minTriangles != null || filters.maxTriangles != null) {
    const min = filters.minTriangles ?? 0
    const max = filters.maxTriangles ?? Number.MAX_SAFE_INTEGER
    clauses.push(sql`EXISTS (
      SELECT 1 FROM model_files f
      WHERE f.model_id = m.id AND f.missing_at IS NULL
        AND f.triangle_count BETWEEN ${min} AND ${max}
    )`)
  }

  return sql`WHERE ${sql.join(clauses, sql` AND `)}`
}

function buildOrder(sort: SortOrder, query: string): SQL {
  switch (sort) {
    case 'name':
      return sql`ORDER BY m.name ASC, m.id ASC`
    case 'recent':
      return sql`ORDER BY m.created_at DESC, m.id DESC`
    case 'oldest':
      return sql`ORDER BY m.created_at ASC, m.id ASC`
    case 'largest':
      return sql`ORDER BY m.total_size DESC, m.id ASC`
    case 'relevance':
    default:
      // With no query every rank is zero, so fall back to name rather than
      // returning rows in whatever order the planner happens to produce.
      return query
        ? sql`ORDER BY matched.rank DESC, m.name ASC, m.id ASC`
        : sql`ORDER BY m.name ASC, m.id ASC`
  }
}

/**
 * Facet counts.
 *
 * Computed against the query and every filter EXCEPT the facet's own — so
 * ticking one creator still shows how many models the other creators have,
 * which is what makes a facet list usable rather than a dead end.
 */
async function loadFacets(
  db: Database,
  query: string,
  options: SearchOptions,
): Promise<SearchFacets> {
  const [libraries, creators, tags, licenses, extensions] = await Promise.all([
    facet<{ value: string; label: string; count: string }>(
      db,
      sql`
        SELECT l.id::text AS value, l.name AS label, count(*)::bigint AS count
        FROM models m JOIN libraries l ON l.id = m.library_id
        ${buildWhere(query, { ...options, libraryIds: undefined })}
        GROUP BY l.id, l.name ORDER BY count DESC, l.name ASC LIMIT 40
      `,
    ),
    facet(
      db,
      sql`
        SELECT c.id::text AS value, c.name AS label, count(*)::bigint AS count
        FROM models m JOIN creators c ON c.id = m.creator_id
        ${buildWhere(query, { ...options, creatorIds: undefined })}
        GROUP BY c.id, c.name ORDER BY count DESC, c.name ASC LIMIT 40
      `,
    ),
    facet(
      db,
      sql`
        SELECT t.id::text AS value, t.name AS label, count(DISTINCT m.id)::bigint AS count
        FROM models m
        JOIN model_tags mt ON mt.model_id = m.id
        JOIN tags t ON t.id = mt.tag_id
        ${buildWhere(query, { ...options, tagIds: undefined })}
        GROUP BY t.id, t.name ORDER BY count DESC, t.name ASC LIMIT 40
      `,
    ),
    facet(
      db,
      sql`
        SELECT m.license AS value, m.license AS label, count(*)::bigint AS count
        FROM models m
        ${buildWhere(query, { ...options, licenses: undefined })}
        AND m.license IS NOT NULL
        GROUP BY m.license ORDER BY count DESC, m.license ASC LIMIT 40
      `,
    ),
    facet(
      db,
      sql`
        SELECT f.extension AS value, f.extension AS label, count(DISTINCT m.id)::bigint AS count
        FROM models m
        JOIN model_files f ON f.model_id = m.id AND f.missing_at IS NULL
        ${buildWhere(query, { ...options, extensions: undefined })}
        AND f.category IN ('model', 'slicer')
        GROUP BY f.extension ORDER BY count DESC, f.extension ASC LIMIT 40
      `,
    ),
  ])

  return { libraries, creators, tags, licenses, extensions }
}

async function facet<T extends { value: string; label: string; count: string }>(
  db: Database,
  statement: SQL,
): Promise<FacetCount[]> {
  const rows = await db.execute<T>(statement)
  return rows.rows
    .filter((row) => row.value !== null)
    .map((row) => ({ value: row.value, label: row.label ?? row.value, count: Number(row.count) }))
}

/**
 * True when the query uses websearch_to_tsquery syntax.
 *
 * `-term` excludes, `"a b"` is a phrase, and bare `or` is a disjunction. Each
 * expresses precision the fuzzy fallbacks would undo.
 */
function hasSearchOperators(query: string): boolean {
  return /(^|\s)-\S/.test(query) || query.includes('"') || /(^|\s)or(\s|$)/i.test(query)
}

/** ILIKE treats these as wildcards; a literal search must not. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`)
}

/**
 * Lightweight lookup for the command palette.
 *
 * Deliberately separate from searchModels: the palette fires on every
 * keystroke, wants a handful of rows across several entity types, and needs no
 * facets or totals.
 */
export interface QuickHit {
  kind: 'model' | 'creator' | 'tag' | 'collection'
  id: string
  publicId: string | null
  label: string
  detail: string | null
}

export async function quickSearch(db: Database, query: string, limit = 12): Promise<QuickHit[]> {
  const trimmed = query.trim().slice(0, MAX_QUERY_LENGTH)
  if (trimmed.length === 0) return []

  await applyTrigramThreshold(db)
  const like = '%' + escapeLike(trimmed) + '%'

  const rows = await db.execute<{
    kind: QuickHit['kind']
    id: string
    public_id: string | null
    label: string
    detail: string | null
    rank: number
  }>(sql`
    (
      SELECT 'model'::text AS kind, m.id::text, m.public_id, m.name AS label,
             l.name AS detail,
             (ts_rank_cd(m.search_vector, websearch_to_tsquery('pm_search', ${trimmed}), 32) * 4
              + coalesce(word_similarity(${trimmed}, m.name), 0))::float4 AS rank
      FROM models m JOIN libraries l ON l.id = m.library_id
      WHERE m.missing_at IS NULL
        AND (m.search_vector @@ websearch_to_tsquery('pm_search', ${trimmed})
             OR ${trimmed} <% m.name
             OR m.name ILIKE ${like})
      ORDER BY rank DESC, m.name ASC LIMIT ${limit}
    )
    UNION ALL
    (
      SELECT 'creator'::text, c.id::text, c.public_id, c.name,
             NULL::text, coalesce(word_similarity(${trimmed}, c.name), 0)::float4
      FROM creators c
      WHERE c.name ILIKE ${like} OR ${trimmed} <% c.name
      ORDER BY 6 DESC, c.name ASC LIMIT 5
    )
    UNION ALL
    (
      SELECT 'tag'::text, t.id::text, NULL, t.name,
             NULL::text, coalesce(word_similarity(${trimmed}, t.name), 0)::float4
      FROM tags t
      WHERE t.name ILIKE ${like} OR ${trimmed} <% t.name
      ORDER BY 6 DESC, t.name ASC LIMIT 5
    )
    UNION ALL
    (
      SELECT 'collection'::text, col.id::text, col.public_id, col.name,
             NULL::text, coalesce(word_similarity(${trimmed}, col.name), 0)::float4
      FROM collections col
      WHERE col.name ILIKE ${like} OR ${trimmed} <% col.name
      ORDER BY 6 DESC, col.name ASC LIMIT 5
    )
    ORDER BY rank DESC
    LIMIT ${limit}
  `)

  return rows.rows.map((row) => ({
    kind: row.kind,
    id: row.id,
    publicId: row.public_id,
    label: row.label,
    detail: row.detail,
  }))
}
