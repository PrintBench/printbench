import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { createDb } from '@pb/db'
import { modelFormatSql } from './model-format'

const url = process.env.DATABASE_URL
const describeDb = url ? describe : describe.skip
const LIB = 'a4230000-0000-4000-8000-000000000001'
const MODEL = 'a4230000-0000-4000-8000-000000000002'

describeDb('model format badges', () => {
  let pool: ReturnType<typeof createDb>['pool']
  let db: ReturnType<typeof createDb>['db']

  beforeAll(() => {
    ;({ pool, db } = createDb(url))
  })

  afterAll(async () => {
    await db.execute(sql`DELETE FROM libraries WHERE id = ${LIB}`)
    await pool.end()
  })

  beforeEach(async () => {
    await db.execute(sql`DELETE FROM libraries WHERE id = ${LIB}`)
    await db.execute(sql`
      INSERT INTO libraries (id, name, kind, backend, path)
      VALUES (${LIB}, 'Model format fixture', 'in_place', 'local', '/fixtures/model-format')`)
    await db.execute(sql`
      INSERT INTO models (id, library_id, path, name, slug, public_id)
      VALUES (${MODEL}, ${LIB}, 'fixture', 'Model format fixture', 'model-format-fixture',
              'formatfx0001')`)
  })

  async function file(
    filename: string,
    category: 'model' | 'slicer' | 'image',
    size: number,
    options: { selected?: boolean; missing?: boolean } = {},
  ) {
    const result = await db.execute<{ id: string }>(sql`
      INSERT INTO model_files (model_id, filename, extension, category, size, media_type, missing_at)
      VALUES (${MODEL}, ${filename}, ${filename.split('.').at(-1)}, ${category}, ${size},
              'application/octet-stream', ${options.missing ? sql`now()` : null})
      RETURNING id`)
    if (options.selected) {
      await db.execute(sql`UPDATE models SET preview_file_id = ${result.rows[0]!.id}
        WHERE id = ${MODEL}`)
    }
  }

  async function format() {
    const result = await db.execute<{ format: string | null }>(sql`
      SELECT ${modelFormatSql(sql`m.id`, sql`m.preview_file_id`)} AS format
      FROM models m WHERE m.id = ${MODEL}`)
    return result.rows[0]!.format
  }

  it('uses a 3MF format while a larger WEBP remains the selected artwork', async () => {
    await file('profile.3mf', 'model', 100)
    await file('cover.webp', 'image', 1000, { selected: true })
    expect(await format()).toBe('3mf')
  })

  it('honours a selected live 3D file over a larger model', async () => {
    await file('body.stl', 'model', 1000)
    await file('project.3mf', 'model', 100, { selected: true })
    expect(await format()).toBe('3mf')
  })

  it('ignores missing model files, even when selected', async () => {
    await file('project.3mf', 'model', 1000, { selected: true, missing: true })
    await file('body.stl', 'model', 100)
    expect(await format()).toBe('stl')
  })

  it('prefers a model to a selected slicer file and falls back to slicer-only files', async () => {
    await file('print.gcode', 'slicer', 1000, { selected: true })
    expect(await format()).toBe('gcode')
    await file('body.stl', 'model', 100)
    expect(await format()).toBe('stl')
  })

  it('has no model format badge for artwork-only packages', async () => {
    await file('cover.webp', 'image', 1000, { selected: true })
    expect(await format()).toBeNull()
  })
})
