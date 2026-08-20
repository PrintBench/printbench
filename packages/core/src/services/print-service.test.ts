import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { createDb } from '@pm/db'
import {
  PrintValidationError,
  deletePrint,
  listPrints,
  logPrint,
  printBelongsToModel,
  printStats,
  printSuggestions,
  updatePrint,
} from './print-service'

/**
 * Print history against a real database.
 *
 * The interesting behaviour here is not the inserts — it is what the numbers
 * say when the data is incomplete, which is the normal case: a print still
 * running, a duration nobody typed in, a model never printed at all.
 */
const url = process.env.DATABASE_URL
const describeDb = url ? describe : describe.skip

const LIB = '71000000-0000-4000-8000-000000000001'
const MODEL_A = '71aa0000-0000-4000-8000-00000000000a'
const MODEL_B = '71bb0000-0000-4000-8000-00000000000b'

describeDb('print history', () => {
  let pool: ReturnType<typeof createDb>['pool']
  let db: ReturnType<typeof createDb>['db']
  let fileId: string

  beforeAll(async () => {
    ;({ pool, db } = createDb(url))
    await cleanup()

    await db.execute(sql`
      INSERT INTO libraries (id, name, kind, backend, path)
      VALUES (${LIB}, 'Print History Fixture', 'in_place', 'local', '/fixtures/prints')
    `)
    for (const [id, suffix, name] of [
      [MODEL_A, 'a', 'Articulated Dragon'],
      [MODEL_B, 'b', 'Cable Clip'],
    ]) {
      await db.execute(sql`
        INSERT INTO models (id, library_id, path, name, slug, public_id, file_count, total_size)
        VALUES (${id}, ${LIB}, ${'ph/' + suffix}, ${name}, ${'ph-' + suffix},
                ${'mdph0000000' + suffix}, 1, 1000)
      `)
    }

    const file = await db.execute<{ id: string }>(sql`
      INSERT INTO model_files (model_id, filename, extension, category, previewable, size, media_type)
      VALUES (${MODEL_A}, 'dragon.stl', 'stl', 'model', true, 1000, 'model/stl')
      RETURNING id
    `)
    fileId = file.rows[0]!.id
  })

  beforeEach(async () => {
    await db.execute(sql`DELETE FROM print_runs WHERE model_id IN (${MODEL_A}, ${MODEL_B})`)
  })

  afterAll(async () => {
    await cleanup()
    await pool.end()
  })

  async function cleanup() {
    // Models and files cascade from the library.
    await db.execute(sql`DELETE FROM print_runs WHERE model_id IN (${MODEL_A}, ${MODEL_B})`)
    await db.execute(sql`DELETE FROM libraries WHERE id = ${LIB}`)
  }

  describe('logPrint', () => {
    it('records a print and reads it back', async () => {
      const { id } = await logPrint(db, {
        modelId: MODEL_A,
        modelFileId: fileId,
        printerName: 'Bambu P1S',
        material: 'PLA',
        colorHex: '#1a2b3c',
        layerHeightMm: 0.2,
        nozzleMm: 0.4,
        status: 'success',
        filamentUsedG: 48.5,
        rating: 5,
        notes: 'Came out clean, no stringing.',
      })

      const [run] = await listPrints(db, { modelId: MODEL_A })

      expect(run!.id).toBe(id)
      expect(run!.printerName).toBe('Bambu P1S')
      // numeric columns come back as strings from pg and must be numbers here.
      expect(run!.layerHeightMm).toBe(0.2)
      expect(run!.filamentUsedG).toBe(48.5)
      expect(run!.rating).toBe(5)
      // Joined, so the timeline can name the file that was printed.
      expect(run!.filename).toBe('dragon.stl')
      // And the model, so a list spanning many of them can link back.
      expect(run!.modelName).toBe('Articulated Dragon')
      expect(run!.modelPublicId).toBe('mdph0000000a')
    })

    it('defaults to success, because that is what people log', async () => {
      await logPrint(db, { modelId: MODEL_A })
      const [run] = await listPrints(db, { modelId: MODEL_A })
      expect(run!.status).toBe('success')
    })

    it('trims blank text down to null rather than storing whitespace', async () => {
      await logPrint(db, { modelId: MODEL_A, printerName: '  ', material: '' })
      const [run] = await listPrints(db, { modelId: MODEL_A })
      expect(run!.printerName).toBeNull()
      expect(run!.material).toBeNull()
    })

    /*
     * Asking for the duration as well as the start and end times invites the
     * two to disagree, so the duration is derived whenever both ends are known.
     */
    it('derives the duration from the start and end times', async () => {
      await logPrint(db, {
        modelId: MODEL_A,
        startedAt: new Date('2026-08-01T09:00:00Z'),
        finishedAt: new Date('2026-08-01T12:30:00Z'),
      })
      const [run] = await listPrints(db, { modelId: MODEL_A })
      expect(run!.durationMin).toBe(210)
    })

    it('keeps an explicit duration over the derived one', async () => {
      // Someone who types a duration means it — the print may have been paused.
      await logPrint(db, {
        modelId: MODEL_A,
        startedAt: new Date('2026-08-01T09:00:00Z'),
        finishedAt: new Date('2026-08-01T12:30:00Z'),
        durationMin: 195,
      })
      const [run] = await listPrints(db, { modelId: MODEL_A })
      expect(run!.durationMin).toBe(195)
    })

    it('leaves the duration unknown when only one end is known', async () => {
      await logPrint(db, {
        modelId: MODEL_A,
        status: 'in_progress',
        startedAt: new Date('2026-08-01T09:00:00Z'),
      })
      const [run] = await listPrints(db, { modelId: MODEL_A })
      expect(run!.durationMin).toBeNull()
    })

    it('truncates a very long note instead of failing the insert', async () => {
      await logPrint(db, { modelId: MODEL_A, notes: 'x'.repeat(9000) })
      const [run] = await listPrints(db, { modelId: MODEL_A })
      expect(run!.notes!.length).toBe(5000)
    })
  })

  describe('validation', () => {
    const invalid: [string, Parameters<typeof logPrint>[1]][] = [
      ['a rating above five', { modelId: MODEL_A, rating: 6 }],
      ['a rating below one', { modelId: MODEL_A, rating: 0 }],
      ['a negative duration', { modelId: MODEL_A, durationMin: -1 }],
      ['negative filament', { modelId: MODEL_A, filamentUsedG: -5 }],
      // Outside this range it is a typo, not a layer height.
      ['a layer height of zero', { modelId: MODEL_A, layerHeightMm: 0 }],
      ['a layer height in microns', { modelId: MODEL_A, layerHeightMm: 200 }],
      ['a colour that is not hex', { modelId: MODEL_A, colorHex: 'red' }],
      [
        'finishing before starting',
        {
          modelId: MODEL_A,
          startedAt: new Date('2026-08-01T12:00:00Z'),
          finishedAt: new Date('2026-08-01T09:00:00Z'),
        },
      ],
    ]

    for (const [label, entry] of invalid) {
      it(`refuses ${label}`, async () => {
        await expect(logPrint(db, entry)).rejects.toThrow(PrintValidationError)
      })
    }

    it('accepts the edges of the valid ranges', async () => {
      await expect(
        logPrint(db, { modelId: MODEL_A, rating: 1, layerHeightMm: 0.05, filamentUsedG: 0 }),
      ).resolves.toBeTruthy()
      await expect(logPrint(db, { modelId: MODEL_A, rating: 5 })).resolves.toBeTruthy()
    })

    it('validates on update as well as insert', async () => {
      const { id } = await logPrint(db, { modelId: MODEL_A })
      await expect(updatePrint(db, id, { rating: 9 })).rejects.toThrow(PrintValidationError)
    })
  })

  describe('updatePrint', () => {
    it('settles a running print', async () => {
      const { id } = await logPrint(db, {
        modelId: MODEL_A,
        status: 'in_progress',
        startedAt: new Date('2026-08-01T09:00:00Z'),
      })

      await updatePrint(db, id, {
        status: 'success',
        finishedAt: new Date('2026-08-01T12:00:00Z'),
        durationMin: 180,
        filamentUsedG: 60,
        rating: 4,
      })

      const [run] = await listPrints(db, { modelId: MODEL_A })
      expect(run!.status).toBe('success')
      expect(run!.durationMin).toBe(180)
      expect(run!.filamentUsedG).toBe(60)
    })

    it('leaves fields alone when they are not mentioned', async () => {
      // A partial update must not blank out the rest of the entry.
      const { id } = await logPrint(db, {
        modelId: MODEL_A,
        printerName: 'Prusa MK4',
        material: 'PETG',
        rating: 3,
      })
      await updatePrint(db, id, { notes: 'Warped a little at the corner.' })

      const [run] = await listPrints(db, { modelId: MODEL_A })
      expect(run!.printerName).toBe('Prusa MK4')
      expect(run!.material).toBe('PETG')
      expect(run!.rating).toBe(3)
      expect(run!.notes).toBe('Warped a little at the corner.')
    })

    it('can clear a rating explicitly', async () => {
      const { id } = await logPrint(db, { modelId: MODEL_A, rating: 2 })
      await updatePrint(db, id, { rating: null })
      const [run] = await listPrints(db, { modelId: MODEL_A })
      expect(run!.rating).toBeNull()
    })
  })

  describe('listPrints', () => {
    it('returns the newest first', async () => {
      await logPrint(db, { modelId: MODEL_A, notes: 'older', startedAt: new Date('2026-07-01') })
      await logPrint(db, { modelId: MODEL_A, notes: 'newer', startedAt: new Date('2026-08-01') })

      const runs = await listPrints(db, { modelId: MODEL_A })
      expect(runs.map((r) => r.notes)).toEqual(['newer', 'older'])
    })

    it('orders a print with no start time by when it was logged', async () => {
      // Otherwise a print logged after the fact would sort to the bottom
      // regardless of when it was entered.
      await logPrint(db, { modelId: MODEL_A, notes: 'dated', startedAt: new Date('2020-01-01') })
      await logPrint(db, { modelId: MODEL_A, notes: 'undated' })

      const runs = await listPrints(db, { modelId: MODEL_A })
      expect(runs[0]!.notes).toBe('undated')
    })

    it('scopes to one model', async () => {
      await logPrint(db, { modelId: MODEL_A })
      await logPrint(db, { modelId: MODEL_B })

      expect(await listPrints(db, { modelId: MODEL_A })).toHaveLength(1)
      expect(await listPrints(db, { modelId: MODEL_B })).toHaveLength(1)
    })

    it('paginates', async () => {
      for (let i = 0; i < 5; i++) {
        await logPrint(db, {
          modelId: MODEL_A,
          notes: `run-${i}`,
          startedAt: new Date(2026, 0, i + 1),
        })
      }

      const page1 = await listPrints(db, { modelId: MODEL_A, limit: 2 })
      const page2 = await listPrints(db, { modelId: MODEL_A, limit: 2, offset: 2 })

      expect(page1.map((r) => r.notes)).toEqual(['run-4', 'run-3'])
      expect(page2.map((r) => r.notes)).toEqual(['run-2', 'run-1'])
    })

    it('filters by outcome', async () => {
      await logPrint(db, { modelId: MODEL_A, status: 'success' })
      await logPrint(db, { modelId: MODEL_A, status: 'failed' })
      await logPrint(db, { modelId: MODEL_A, status: 'in_progress' })

      const failed = await listPrints(db, { modelId: MODEL_A, status: ['failed'] })
      expect(failed.map((r) => r.status)).toEqual(['failed'])

      // Several at once, which is how the "failures" filter is built.
      const unhappy = await listPrints(db, { modelId: MODEL_A, status: ['failed', 'in_progress'] })
      expect(unhappy).toHaveLength(2)
    })

    it('treats an empty status list as no filter', async () => {
      await logPrint(db, { modelId: MODEL_A, status: 'success' })
      expect(await listPrints(db, { modelId: MODEL_A, status: [] })).toHaveLength(1)
    })

    it('caps an absurd limit rather than trying to serve it', async () => {
      await logPrint(db, { modelId: MODEL_A })
      await expect(listPrints(db, { modelId: MODEL_A, limit: 10_000 })).resolves.toBeTruthy()
      await expect(listPrints(db, { modelId: MODEL_A, limit: -5 })).resolves.toBeTruthy()
    })
  })

  describe('printStats', () => {
    it('reports nothing for a model never printed', async () => {
      const stats = await printStats(db, MODEL_B)
      expect(stats.total).toBe(0)
      expect(stats.successRate).toBeNull()
      expect(stats.lastPrintedAt).toBeNull()
    })

    /*
     * The distinction that matters: a brand-new model with one print still
     * running is not a 0% success rate, and showing it as one is actively
     * misleading. Null means "no verdict yet".
     */
    it('has no success rate while nothing has settled', async () => {
      await logPrint(db, { modelId: MODEL_A, status: 'in_progress' })
      const stats = await printStats(db, MODEL_A)

      expect(stats.total).toBe(1)
      expect(stats.successRate).toBeNull()
    })

    it('computes the rate over settled prints only', async () => {
      await logPrint(db, { modelId: MODEL_A, status: 'success' })
      await logPrint(db, { modelId: MODEL_A, status: 'success' })
      await logPrint(db, { modelId: MODEL_A, status: 'success' })
      await logPrint(db, { modelId: MODEL_A, status: 'failed' })
      await logPrint(db, { modelId: MODEL_A, status: 'in_progress' })

      const stats = await printStats(db, MODEL_A)
      expect(stats.total).toBe(5)
      expect(stats.successes).toBe(3)
      expect(stats.failures).toBe(1)
      // The running print is excluded from the denominator, not counted against it.
      expect(stats.successRate).toBeCloseTo(0.75)
    })

    it('counts a partial print as neither a success nor a failure', async () => {
      await logPrint(db, { modelId: MODEL_A, status: 'success' })
      await logPrint(db, { modelId: MODEL_A, status: 'partial' })

      const stats = await printStats(db, MODEL_A)
      expect(stats.total).toBe(2)
      expect(stats.successRate).toBe(1)
    })

    it('totals filament and time', async () => {
      await logPrint(db, { modelId: MODEL_A, filamentUsedG: 48.5, durationMin: 120 })
      await logPrint(db, { modelId: MODEL_A, filamentUsedG: 11.25, durationMin: 45 })

      const stats = await printStats(db, MODEL_A)
      expect(stats.totalFilamentG).toBeCloseTo(59.75)
      expect(stats.totalDurationMin).toBe(165)
    })

    it('reports the most recent print', async () => {
      await logPrint(db, { modelId: MODEL_A, startedAt: new Date('2026-07-01T10:00:00Z') })
      await logPrint(db, { modelId: MODEL_A, startedAt: new Date('2026-08-12T10:00:00Z') })

      const stats = await printStats(db, MODEL_A)
      expect(stats.lastPrintedAt?.toISOString()).toBe('2026-08-12T10:00:00.000Z')
    })

    it('covers every model when given no id', async () => {
      await logPrint(db, { modelId: MODEL_A })
      await logPrint(db, { modelId: MODEL_B })

      const stats = await printStats(db)
      expect(stats.total).toBeGreaterThanOrEqual(2)
    })
  })

  describe('printSuggestions', () => {
    it('offers what has been used before, most used first', async () => {
      for (const material of ['PLA', 'PLA', 'PLA', 'PETG', 'PETG', 'ABS']) {
        await logPrint(db, { modelId: MODEL_A, material, printerName: 'Bambu P1S' })
      }

      const { materials, printers } = await printSuggestions(db)
      expect(materials.indexOf('PLA')).toBeLessThan(materials.indexOf('PETG'))
      expect(materials).toContain('ABS')
      expect(printers).toContain('Bambu P1S')
    })
  })

  describe('printBelongsToModel', () => {
    // Guards edit and delete: the print id arrives from the client, and without
    // this check one model's page could delete another model's history.
    it('is true only for the model that owns the print', async () => {
      const { id } = await logPrint(db, { modelId: MODEL_A })

      expect(await printBelongsToModel(db, id, MODEL_A)).toBe(true)
      expect(await printBelongsToModel(db, id, MODEL_B)).toBe(false)
    })

    it('is false for a print that does not exist', async () => {
      const missing = '71ff0000-0000-4000-8000-0000000000ff'
      expect(await printBelongsToModel(db, missing, MODEL_A)).toBe(false)
    })
  })

  describe('deletePrint', () => {
    it('removes the entry', async () => {
      const { id } = await logPrint(db, { modelId: MODEL_A })
      await deletePrint(db, id)
      expect(await listPrints(db, { modelId: MODEL_A })).toHaveLength(0)
    })
  })
})
