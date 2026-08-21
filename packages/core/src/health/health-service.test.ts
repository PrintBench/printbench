import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { createDb } from '@pb/db'
import {
  COSMETIC_KINDS,
  PROBLEM_META,
  detectProblems,
  ignoreKind,
  ignoreProblems,
  listProblems,
  problemSummary,
  resolveProblems,
  unignoreProblems,
  type ProblemKind,
} from './health-service'

/**
 * Library health, against a fixture library built to be broken in nine ways.
 *
 * The behaviour that matters is not raising a problem — it is clearing one.
 * A dashboard that keeps reporting things you have already fixed stops being
 * read, so most of these tests fix something and assert it goes away.
 */
const url = process.env.DATABASE_URL
const describeDb = url ? describe : describe.skip

const LIB = '88000000-0000-4000-8000-000000000001'
const OTHER_LIB = '88000000-0000-4000-8000-000000000002'
const CREATOR = '88000000-0000-4000-8000-00000000000c'
const TAG = '88000000-0000-4000-8000-00000000000d'

const id = (suffix: string) => `88aa0000-0000-4000-8000-0000000000${suffix}`

describeDb('library health', () => {
  let pool: ReturnType<typeof createDb>['pool']
  let db: ReturnType<typeof createDb>['db']

  const kindsFor = async (modelSuffix: string): Promise<ProblemKind[]> => {
    const rows = await db.execute<{ kind: ProblemKind }>(sql`
      SELECT kind FROM problems
      WHERE model_id = ${id(modelSuffix)} AND resolved_at IS NULL ORDER BY kind`)
    return rows.rows.map((row) => row.kind)
  }

  beforeAll(async () => {
    ;({ pool, db } = createDb())
  })

  afterAll(async () => {
    await cleanup()
    await pool.end()
  })

  beforeEach(async () => {
    await cleanup()
    await seed()
  })

  async function cleanup() {
    await db.execute(sql`
      DELETE FROM problems WHERE model_id IN (SELECT id FROM models WHERE library_id IN (${LIB}, ${OTHER_LIB}))
         OR model_id IS NULL`)
    await db.execute(sql`DELETE FROM libraries WHERE id IN (${LIB}, ${OTHER_LIB})`)
    await db.execute(sql`DELETE FROM creators WHERE id = ${CREATOR} OR lower(name) = 'health studios'`)
    await db.execute(sql`DELETE FROM tags WHERE id = ${TAG} OR lower(name) = 'healthy'`)
  }

  /**
   * One library, each model broken in a specific way, plus one model that is
   * entirely healthy so "raises nothing" has something to prove.
   */
  async function seed() {
    await db.execute(sql`
      INSERT INTO libraries (id, name, kind, backend, path) VALUES
        (${LIB}, 'Health Fixture', 'in_place', 'local', '/fixtures/health'),
        (${OTHER_LIB}, 'Other Fixture', 'in_place', 'local', '/fixtures/other')`)
    await db.execute(sql`
      INSERT INTO creators (id, name, slug, public_id)
      VALUES (${CREATOR}, 'Health Studios', 'health-studios-hx', 'crhx00000001')`)
    await db.execute(sql`INSERT INTO tags (id, name, slug) VALUES (${TAG}, 'healthy', 'healthy-hx')`)

    // suffix, path, name, creator, licence, fileCount, missing
    const models: [string, string, string, string | null, string | null, number, boolean][] = [
      ['01', 'healthy', 'Healthy Model', CREATOR, 'CC-BY-4.0', 2, false],
      ['02', 'gone', 'Gone Model', CREATOR, 'MIT', 1, true],
      ['03', 'empty-folder', 'Empty Model', CREATOR, 'MIT', 0, false],
      ['04', 'bare', 'Bare Model', null, null, 1, false],
      ['05', 'pack', 'Pack', CREATOR, 'MIT', 1, false],
      ['06', 'pack/inner', 'Inner Model', CREATOR, 'MIT', 1, false],
      ['07', 'broken', 'Broken Model', CREATOR, 'MIT', 1, false],
      ['08', 'dupe-a', 'Dupe A', CREATOR, 'MIT', 1, false],
      ['09', 'dupe-b', 'Dupe B', CREATOR, 'MIT', 1, false],
    ]

    for (const [suffix, p, name, creator, license, fileCount, missing] of models) {
      await db.execute(sql`
        INSERT INTO models (id, library_id, path, name, slug, public_id, creator_id, license,
                            file_count, total_size, missing_at)
        VALUES (${id(suffix)}, ${LIB}, ${p}, ${name}, ${'hx-' + suffix},
                ${'mdhx0000000' + suffix}, ${creator}, ${license}, ${fileCount}, 1000,
                ${missing ? sql`now()` : null})`)
    }

    // Every model except the bare one is tagged, so no_tags is specific.
    for (const suffix of ['01', '02', '03', '05', '06', '07', '08', '09']) {
      await db.execute(
        sql`INSERT INTO model_tags (model_id, tag_id) VALUES (${id(suffix)}, ${TAG})`,
      )
    }

    // suffix, filename, category, thumbState, analysisState, digest
    const files: [string, string, string, string, string, string | null][] = [
      ['01', 'body.stl', 'model', 'ok', 'ok', 'digest-healthy'],
      ['01', 'cover.png', 'image', 'skipped', 'skipped', null],
      ['04', 'bare.stl', 'model', 'ok', 'ok', 'digest-bare'],
      ['05', 'pack.stl', 'model', 'ok', 'ok', 'digest-pack'],
      ['06', 'inner.stl', 'model', 'ok', 'ok', 'digest-inner'],
      // Truncated mesh: parsed and rendered, both failed.
      ['07', 'broken.stl', 'model', 'failed', 'failed', 'digest-broken'],
      // The same bytes in two models.
      ['08', 'same.stl', 'model', 'ok', 'ok', 'digest-shared'],
      ['09', 'same.stl', 'model', 'ok', 'ok', 'digest-shared'],
    ]

    for (const [suffix, filename, category, thumb, analysis, digest] of files) {
      await db.execute(sql`
        INSERT INTO model_files (model_id, filename, extension, category, media_type, size,
                                 previewable, thumb_state, analysis_state, digest)
        VALUES (${id(suffix)}, ${filename}, ${filename.split('.').pop()}, ${category}::file_category,
                'application/octet-stream', 1000, ${category === 'model'},
                ${thumb}::derived_state, ${analysis}::derived_state, ${digest})`)
    }
  }

  describe('detection', () => {
    it('finds each kind of problem in the right place', async () => {
      await detectProblems(db, { libraryId: LIB })

      expect(await kindsFor('02')).toContain('missing')
      expect(await kindsFor('03')).toContain('empty')
      expect(await kindsFor('04')).toContain('no_creator')
      expect(await kindsFor('04')).toContain('no_license')
      expect(await kindsFor('04')).toContain('no_tags')
      expect(await kindsFor('06')).toContain('nested_model')
      expect(await kindsFor('07')).toContain('unparseable')
    })

    it('leaves a healthy model alone', async () => {
      await detectProblems(db, { libraryId: LIB })
      expect(await kindsFor('01')).toEqual([])
    })

    /*
     * A rendered thumbnail is a perfectly good preview. Only a model with
     * neither a supplied image nor a successful render is missing one.
     */
    it('accepts a rendered thumbnail as a preview', async () => {
      await detectProblems(db, { libraryId: LIB })
      expect(await kindsFor('04')).not.toContain('no_image')
      // The broken model rendered nothing and has no image either.
      expect(await kindsFor('07')).toContain('no_image')
    })

    it('reports a duplicate once, not once per copy', async () => {
      await detectProblems(db, { libraryId: LIB })

      const dupes = await db.execute<{ count: number }>(sql`
        SELECT count(*)::int FROM problems p
        JOIN models m ON m.id = p.model_id
        WHERE p.kind = 'duplicate_digest' AND p.resolved_at IS NULL
          AND m.library_id = ${LIB}`)
      // Two files share bytes; only the second is the duplicate.
      expect(dupes.rows[0]!.count).toBe(1)
    })

    it('does not call a sibling folder nested', async () => {
      // "pack/inner" is inside "pack"; "dupe-a" and "dupe-b" are not.
      expect(await kindsFor('08')).not.toContain('nested_model')
      await detectProblems(db, { libraryId: LIB })
      expect(await kindsFor('08')).not.toContain('nested_model')
    })

    it('does not mistake a name prefix for a parent folder', async () => {
      // Without the separator, "Dragon" would look like the parent of
      // "Dragonborn" and every such pair would be reported.
      await db.execute(sql`
        INSERT INTO models (id, library_id, path, name, slug, public_id, file_count, total_size)
        VALUES (${id('10')}, ${LIB}, 'dupe-a-extra', 'Dupe A Extra', 'hx-10', 'mdhx00000010', 1, 10)`)
      await detectProblems(db, { libraryId: LIB })
      expect(await kindsFor('10')).not.toContain('nested_model')
    })

    it('is idempotent', async () => {
      const first = await detectProblems(db, { libraryId: LIB })
      const second = await detectProblems(db, { libraryId: LIB })

      expect(first.raised).toBeGreaterThan(0)
      // Everything was already open, so nothing new is raised.
      expect(second.raised).toBe(0)
      expect(second.resolved).toBe(0)
    })

    it('can skip the tidiness kinds', async () => {
      await detectProblems(db, { libraryId: LIB, skipCosmetic: true })

      // Scoped to the fixture library: other suites share this database, and
      // an unscoped query picks up their problems too.
      const raised = await db.execute<{ kind: ProblemKind }>(sql`
        SELECT DISTINCT p.kind FROM problems p
        JOIN models m ON m.id = p.model_id
        WHERE p.resolved_at IS NULL AND m.library_id = ${LIB}`)
      for (const row of raised.rows) {
        expect(COSMETIC_KINDS).not.toContain(row.kind)
      }
    })

    it('grades data loss above untidiness', async () => {
      await detectProblems(db, { libraryId: LIB })
      expect(PROBLEM_META.missing.severity).toBe('danger')
      expect(PROBLEM_META.no_license.severity).toBe('info')
    })
  })

  describe('self-resolution', () => {
    it('clears a licence problem once a licence is set', async () => {
      await detectProblems(db, { libraryId: LIB })
      expect(await kindsFor('04')).toContain('no_license')

      await db.execute(sql`UPDATE models SET license = 'MIT' WHERE id = ${id('04')}`)
      const result = await detectProblems(db, { libraryId: LIB })

      expect(await kindsFor('04')).not.toContain('no_license')
      expect(result.resolved).toBeGreaterThan(0)
    })

    it('clears a missing problem once the folder comes back', async () => {
      await detectProblems(db, { libraryId: LIB })
      expect(await kindsFor('02')).toContain('missing')

      await db.execute(sql`UPDATE models SET missing_at = NULL WHERE id = ${id('02')}`)
      await detectProblems(db, { libraryId: LIB })

      expect(await kindsFor('02')).not.toContain('missing')
    })

    /*
     * Resolved, not deleted: the row records that something was once wrong, and
     * deleting it would let a problem be raised and cleared repeatedly with no
     * trace of either.
     */
    it('keeps the resolved row rather than deleting it', async () => {
      await detectProblems(db, { libraryId: LIB })
      await db.execute(sql`UPDATE models SET license = 'MIT' WHERE id = ${id('04')}`)
      await detectProblems(db, { libraryId: LIB })

      const rows = await db.execute<{ count: number }>(sql`
        SELECT count(*)::int FROM problems
        WHERE model_id = ${id('04')} AND kind = 'no_license' AND resolved_at IS NOT NULL`)
      expect(rows.rows[0]!.count).toBe(1)
    })

    it('raises again if the same thing breaks a second time', async () => {
      await detectProblems(db, { libraryId: LIB })
      await db.execute(sql`UPDATE models SET license = 'MIT' WHERE id = ${id('04')}`)
      await detectProblems(db, { libraryId: LIB })
      await db.execute(sql`UPDATE models SET license = NULL WHERE id = ${id('04')}`)
      await detectProblems(db, { libraryId: LIB })

      expect(await kindsFor('04')).toContain('no_license')
    })

    /*
     * The failure this guards against: a per-library run resolving every other
     * library's problems, because their subjects are absent from this
     * detector's output.
     */
    it('does not resolve another library\'s problems', async () => {
      await db.execute(sql`
        INSERT INTO models (id, library_id, path, name, slug, public_id, file_count, total_size)
        VALUES (${id('20')}, ${OTHER_LIB}, 'other', 'Other Model', 'hx-20', 'mdhx00000020', 1, 10)`)

      await detectProblems(db)
      expect(await kindsFor('20')).toContain('no_license')

      // Now examine only the first library.
      await detectProblems(db, { libraryId: LIB })
      expect(await kindsFor('20')).toContain('no_license')
    })
  })

  describe('triage', () => {
    it('hides an ignored problem without claiming it was fixed', async () => {
      await detectProblems(db, { libraryId: LIB })
      const [problem] = await listProblems(db, { kind: 'no_license', libraryId: LIB })

      await ignoreProblems(db, [problem!.id])

      const visible = await listProblems(db, { kind: 'no_license', libraryId: LIB })
      expect(visible.map((p) => p.id)).not.toContain(problem!.id)

      const withIgnored = await listProblems(db, {
        kind: 'no_license',
        libraryId: LIB,
        includeIgnored: true,
      })
      expect(withIgnored.map((p) => p.id)).toContain(problem!.id)
    })

    /*
     * Ignored problems stay open on purpose. If ignoring resolved them, the
     * next detection would raise a fresh copy and the dismissal would appear
     * not to have worked.
     */
    it('does not re-raise an ignored problem', async () => {
      await detectProblems(db, { libraryId: LIB })
      const [problem] = await listProblems(db, { kind: 'no_license', libraryId: LIB })
      await ignoreProblems(db, [problem!.id])

      await detectProblems(db, { libraryId: LIB })

      const rows = await db.execute<{ count: number }>(sql`
        SELECT count(*)::int FROM problems
        WHERE id = ${problem!.id} AND ignored_at IS NOT NULL AND resolved_at IS NULL`)
      expect(rows.rows[0]!.count).toBe(1)
    })

    it('can un-ignore', async () => {
      await detectProblems(db, { libraryId: LIB })
      const [problem] = await listProblems(db, { kind: 'no_license', libraryId: LIB })

      await ignoreProblems(db, [problem!.id])
      await unignoreProblems(db, [problem!.id])

      const visible = await listProblems(db, { kind: 'no_license', libraryId: LIB })
      expect(visible.map((p) => p.id)).toContain(problem!.id)
    })

    it('ignores a whole kind at once', async () => {
      await detectProblems(db, { libraryId: LIB })
      const count = await ignoreKind(db, 'no_license')

      expect(count).toBeGreaterThan(0)
      expect(await listProblems(db, { kind: 'no_license', libraryId: LIB })).toHaveLength(0)
    })

    it('resolves by hand', async () => {
      await detectProblems(db, { libraryId: LIB })
      const [problem] = await listProblems(db, { kind: 'no_license', libraryId: LIB })

      await resolveProblems(db, [problem!.id])
      expect(await listProblems(db, { kind: 'no_license', libraryId: LIB })).not.toContainEqual(
        expect.objectContaining({ id: problem!.id }),
      )
    })

    it('does nothing for an empty id list', async () => {
      expect(await ignoreProblems(db, [])).toBe(0)
      expect(await resolveProblems(db, [])).toBe(0)
      expect(await unignoreProblems(db, [])).toBe(0)
    })
  })

  describe('listing', () => {
    it('names the model and library for context', async () => {
      await detectProblems(db, { libraryId: LIB })
      const [problem] = await listProblems(db, { kind: 'missing', libraryId: LIB })

      expect(problem!.modelName).toBe('Gone Model')
      expect(problem!.libraryName).toBe('Health Fixture')
      expect(problem!.modelPublicId).toBe('mdhx0000000' + '02')
    })

    it('names the file when the problem is about one', async () => {
      await detectProblems(db, { libraryId: LIB })
      const [problem] = await listProblems(db, { kind: 'unparseable', libraryId: LIB })
      expect(problem!.filename).toBe('broken.stl')
    })

    it('puts the worst first', async () => {
      await detectProblems(db, { libraryId: LIB })
      const problems = await listProblems(db, { libraryId: LIB })
      expect(problems[0]!.severity).toBe('danger')
    })

    it('filters by severity', async () => {
      await detectProblems(db, { libraryId: LIB })
      const dangers = await listProblems(db, { libraryId: LIB, severity: 'danger' })
      expect(dangers.every((p) => p.severity === 'danger')).toBe(true)
      expect(dangers.length).toBeGreaterThan(0)
    })

    it('summarises by kind', async () => {
      await detectProblems(db, { libraryId: LIB })
      const summary = await problemSummary(db, LIB)

      const missing = summary.find((row) => row.kind === 'missing')
      expect(missing?.open).toBe(1)
      expect(missing?.ignored).toBe(0)
    })

    it('counts ignored separately from open', async () => {
      await detectProblems(db, { libraryId: LIB })
      await ignoreKind(db, 'no_license')

      const summary = await problemSummary(db, LIB)
      const licences = summary.find((row) => row.kind === 'no_license')
      expect(licences?.open).toBe(0)
      expect(licences?.ignored).toBeGreaterThan(0)
    })
  })
})
