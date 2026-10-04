import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { createDb } from '@pb/db'
import { modelFormatSql, modelGeometrySql, modelThumbnailSql } from './model-format'

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
    options: {
      selected?: boolean
      missing?: boolean
      dimensions?: [number, number, number]
      analysisState?: 'ok' | 'pending' | 'failed'
    } = {},
  ) {
    const result = await db.execute<{ id: string }>(sql`
      INSERT INTO model_files (model_id, filename, extension, category, size, media_type, missing_at,
                               bbox_x, bbox_y, bbox_z, analysis_state, thumb_state)
      VALUES (${MODEL}, ${filename}, ${filename.split('.').at(-1)}, ${category}, ${size},
              'application/octet-stream', ${options.missing ? sql`now()` : null},
              ${options.dimensions?.[0] ?? null}, ${options.dimensions?.[1] ?? null},
              ${options.dimensions?.[2] ?? null},
              ${options.analysisState ?? (options.dimensions ? 'ok' : 'pending')}, 'failed')
      RETURNING id`)
    if (options.selected) {
      await db.execute(sql`UPDATE models SET preview_file_id = ${result.rows[0]!.id}
        WHERE id = ${MODEL}`)
    }
    return result.rows[0]!.id
  }

  async function format() {
    const result = await db.execute<{ format: string | null }>(sql`
      SELECT ${modelFormatSql(sql`m.id`, sql`m.preview_file_id`)} AS format
      FROM models m WHERE m.id = ${MODEL}`)
    return result.rows[0]!.format
  }

  async function geometry() {
    const result = await db.execute<{
      id: string | null
      bbox_x: string | null
      bbox_y: string | null
      bbox_z: string | null
    }>(sql`
      SELECT geometry.id, geometry.bbox_x, geometry.bbox_y, geometry.bbox_z
      FROM models m
      LEFT JOIN LATERAL (${modelGeometrySql(sql`m.id`, sql`m.preview_file_id`)}) geometry ON true
      WHERE m.id = ${MODEL}`)
    return result.rows[0]!
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

  it('uses analyzed geometry with selected artwork even when thumbnail rendering failed', async () => {
    const model = await file('profile.3mf', 'model', 100, { dimensions: [415, 385, 79] })
    await file('cover.webp', 'image', 1000, { selected: true, dimensions: [1, 1, 1] })
    expect(await geometry()).toEqual({
      id: model,
      bbox_x: '415.0000',
      bbox_y: '385.0000',
      bbox_z: '79.0000',
    })
  })

  it('honours selected analyzed model geometry over the largest file', async () => {
    await file('body.stl', 'model', 1000, { dimensions: [100, 100, 100] })
    const selected = await file('project.3mf', 'model', 100, {
      selected: true,
      dimensions: [20, 30, 40],
    })
    expect((await geometry()).id).toBe(selected)
  })

  it('falls back from pending or missing selected geometry to a live analyzed model', async () => {
    const live = await file('body.stl', 'model', 100, { dimensions: [20, 30, 40] })
    await file('pending.3mf', 'model', 1000, {
      selected: true,
      dimensions: [100, 100, 100],
      analysisState: 'pending',
    })
    expect((await geometry()).id).toBe(live)
    await file('missing.3mf', 'model', 2000, {
      selected: true,
      missing: true,
      dimensions: [200, 200, 200],
    })
    expect((await geometry()).id).toBe(live)
  })

  it('does not display incomplete or invalid geometry as model dimensions', async () => {
    await file('invalid.3mf', 'model', 2000, { dimensions: [-1, 20, 30], selected: true })
    await file('unknown.stl', 'model', 1000)
    await file('cover.webp', 'image', 3000, { dimensions: [1, 1, 1] })
    expect(await geometry()).toEqual({ id: null, bbox_x: null, bbox_y: null, bbox_z: null })
  })

  it('returns the cache key with the selected live thumbnail and excludes missing previews', async () => {
    const fallback = await file('body.stl', 'model', 1000)
    const selected = await file('project.3mf', 'model', 100, { selected: true })
    await db.execute(sql`UPDATE model_files SET thumb_state = 'ok', thumb_key = 'fallback-v1'
      WHERE id = ${fallback}`)
    await db.execute(sql`UPDATE model_files SET thumb_state = 'ok', thumb_key = 'selected-v2'
      WHERE id = ${selected}`)
    const thumbnail = async () => {
      const result = await db.execute<{ id: string; thumb_key: string }>(sql`
        SELECT thumb.id, thumb.thumb_key FROM models m
        LEFT JOIN LATERAL (${modelThumbnailSql(sql`m.id`, sql`m.preview_file_id`)}) thumb ON true
        WHERE m.id = ${MODEL}`)
      return result.rows[0]
    }
    expect(await thumbnail()).toEqual({ id: selected, thumb_key: 'selected-v2' })
    await db.execute(sql`UPDATE model_files SET missing_at = now() WHERE id = ${selected}`)
    expect(await thumbnail()).toEqual({ id: fallback, thumb_key: 'fallback-v1' })
  })
})
