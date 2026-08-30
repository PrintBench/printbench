import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { createDb } from '@pb/db'
import {
  RequestValidationError,
  createRequest,
  createRequests,
  deleteRequest,
  findExactModelMatch,
  getRequest,
  linkRequest,
  listRequests,
  openRequestsForModel,
  parseRequestLines,
  queueStats,
  requesterSuggestions,
  setRequestStatus,
  updateRequest,
} from './request-service'

/**
 * The print queue.
 *
 * Two things carry most of the risk here and get most of the tests: the line
 * parser, which reads what a person typed in a hurry, and the auto-link, which
 * fills in a field nobody will re-check afterwards. Both are wrong in a way
 * that is quiet rather than loud, so they are pinned down hard.
 */

/* The parser is pure, so it runs whether or not a database is available. */
describe('parsing a pasted list', () => {
  it('makes one request per line', () => {
    expect(parseRequestLines('Dragon\nCable clip\nVase')).toEqual([
      { title: 'Dragon', quantity: 1 },
      { title: 'Cable clip', quantity: 1 },
      { title: 'Vase', quantity: 1 },
    ])
  })

  it('ignores blank lines and surrounding whitespace', () => {
    expect(parseRequestLines('  Dragon  \n\n\n   \n Vase ')).toEqual([
      { title: 'Dragon', quantity: 1 },
      { title: 'Vase', quantity: 1 },
    ])
  })

  it('strips the list punctuation people paste along with the text', () => {
    expect(parseRequestLines('- Dragon\n* Vase\n1. Clip\n2) Hook')).toEqual([
      { title: 'Dragon', quantity: 1 },
      { title: 'Vase', quantity: 1 },
      { title: 'Clip', quantity: 1 },
      { title: 'Hook', quantity: 1 },
    ])
  })

  it('reads a trailing quantity', () => {
    expect(parseRequestLines('Cable clip x4')).toEqual([{ title: 'Cable clip', quantity: 4 }])
    expect(parseRequestLines('Cable clip X 12')).toEqual([{ title: 'Cable clip', quantity: 12 }])
    expect(parseRequestLines('Cable clip ×3')).toEqual([{ title: 'Cable clip', quantity: 3 }])
  })

  it('reads a leading quantity', () => {
    expect(parseRequestLines('4x cable clip')).toEqual([{ title: 'cable clip', quantity: 4 }])
    expect(parseRequestLines('2 × vase')).toEqual([{ title: 'vase', quantity: 2 }])
  })

  /*
   * The case the whitespace rule exists for. "2x2" is the size of the bin, not
   * an order for two of them, and reading it as a quantity would both halve
   * the order and rename the thing.
   */
  it('does not mistake a dimension in the name for a quantity', () => {
    expect(parseRequestLines('Gridfinity 2x2')).toEqual([{ title: 'Gridfinity 2x2', quantity: 1 }])
    expect(parseRequestLines('3x3 grid')).toEqual([{ title: '3x3 grid', quantity: 1 }])
  })

  it('takes the multiplier off a name that also contains a dimension', () => {
    expect(parseRequestLines('Gridfinity 2x2 x4')).toEqual([
      { title: 'Gridfinity 2x2', quantity: 4 },
    ])
  })

  it('keeps an "x" that is not a quantity', () => {
    expect(parseRequestLines('Model x')).toEqual([{ title: 'Model x', quantity: 1 }])
  })

  /*
   * "x4" on its own is not a quantity — there is nothing for it to multiply.
   * It is kept as written rather than dropped: silently discarding a line
   * someone typed is the one outcome they cannot see and correct.
   */
  it('keeps a line that is nothing but a bare multiplier', () => {
    expect(parseRequestLines('x4')).toEqual([{ title: 'x4', quantity: 1 }])
  })

  it('caps a runaway paste', () => {
    const lines = Array.from({ length: 500 }, (_, i) => `Thing ${i}`).join('\n')
    expect(parseRequestLines(lines)).toHaveLength(50)
  })
})

const url = process.env.DATABASE_URL
const describeDb = url ? describe : describe.skip

const LIB = '7d000000-0000-4000-8000-000000000001'
const DRAGON = '7daa0000-0000-4000-8000-00000000000a'
const CLIP = '7daa0000-0000-4000-8000-00000000000b'
/* Two models sharing a name, so the auto-link has something ambiguous to refuse. */
const TWIN_ONE = '7daa0000-0000-4000-8000-00000000000c'
const TWIN_TWO = '7daa0000-0000-4000-8000-00000000000d'
const GONE = '7daa0000-0000-4000-8000-00000000000e'
const USER = 'request-test-user'

describeDb('print queue', () => {
  let pool: ReturnType<typeof createDb>['pool']
  let db: ReturnType<typeof createDb>['db']
  let dragonFileId: string
  let clipFileId: string

  beforeAll(async () => {
    ;({ pool, db } = createDb(url))
    await cleanup()

    await db.execute(sql`
      INSERT INTO "user" (id, name, email, email_verified)
      VALUES (${USER}, 'Queue Tester', 'queue-tester@example.test', true)`)

    await db.execute(sql`
      INSERT INTO libraries (id, name, kind, backend, path)
      VALUES (${LIB}, 'Queue Fixture', 'in_place', 'local', '/fixtures/queue')`)

    const models: [string, string, string][] = [
      [DRAGON, 'a', 'Articulated Dragon'],
      [CLIP, 'b', 'Cable Clip'],
      [TWIN_ONE, 'c', 'Twin Model'],
      [TWIN_TWO, 'd', 'twin model'],
      [GONE, 'e', 'Vanished Model'],
    ]
    for (const [id, suffix, name] of models) {
      await db.execute(sql`
        INSERT INTO models (id, library_id, path, name, slug, public_id, file_count, total_size)
        VALUES (${id}, ${LIB}, ${'q/' + suffix}, ${name}, ${'q-' + suffix},
                ${'mdq00000000' + suffix}, 1, 1000)`)
    }
    await db.execute(sql`UPDATE models SET missing_at = now() WHERE id = ${GONE}`)

    dragonFileId = await insertFile(DRAGON, 'dragon.stl')
    clipFileId = await insertFile(CLIP, 'clip.stl')
  })

  async function insertFile(modelId: string, filename: string): Promise<string> {
    const row = await db.execute<{ id: string }>(sql`
      INSERT INTO model_files (model_id, filename, extension, category, previewable, size)
      VALUES (${modelId}, ${filename}, 'stl', 'model', true, 1000)
      RETURNING id`)
    return row.rows[0]!.id
  }

  afterAll(async () => {
    await cleanup()
    await pool.end()
  })

  beforeEach(async () => {
    await db.execute(sql`DELETE FROM print_requests`)
  })

  async function cleanup() {
    await db.execute(sql`DELETE FROM print_requests`)
    await db.execute(sql`DELETE FROM models WHERE library_id = ${LIB}`)
    await db.execute(sql`DELETE FROM libraries WHERE id = ${LIB}`)
    await db.execute(sql`DELETE FROM "user" WHERE id = ${USER}`)
  }

  describe('creating', () => {
    it('needs nothing but a title', async () => {
      const { id } = await createRequest(db, { title: 'Something for the kitchen roll' }, USER)

      const request = await getRequest(db, id)
      expect(request).toMatchObject({
        title: 'Something for the kitchen roll',
        status: 'requested',
        priority: 'normal',
        quantity: 1,
        modelId: null,
        closedAt: null,
      })
    })

    it('refuses a blank title', async () => {
      await expect(createRequest(db, { title: '   ' }, USER)).rejects.toBeInstanceOf(
        RequestValidationError,
      )
    })

    it('refuses a quantity below one', async () => {
      await expect(createRequest(db, { title: 'Vase', quantity: 0 }, USER)).rejects.toBeInstanceOf(
        RequestValidationError,
      )
    })

    it('refuses a colour that is not a hex value', async () => {
      await expect(
        createRequest(db, { title: 'Vase', colorHex: 'red' }, USER),
      ).rejects.toBeInstanceOf(RequestValidationError)
    })

    it('records who asked, even when they have no account', async () => {
      const { id } = await createRequest(db, { title: 'Vase', requestedBy: 'Nan' }, USER)
      expect((await getRequest(db, id))?.requestedBy).toBe('Nan')
    })
  })

  describe('linking to the library', () => {
    it('links a title that names exactly one model', async () => {
      const { id, autoLinked } = await createRequest(db, { title: 'articulated DRAGON' }, USER)

      expect(autoLinked).toBe(true)
      expect(await getRequest(db, id)).toMatchObject({
        modelId: DRAGON,
        modelName: 'Articulated Dragon',
      })
    })

    /*
     * The important refusal. Guessing between two models with the same name
     * fills the field in with a coin toss, and a filled-in field is one nobody
     * looks at again.
     */
    it('leaves an ambiguous title unlinked', async () => {
      const { id, autoLinked } = await createRequest(db, { title: 'Twin Model' }, USER)

      expect(autoLinked).toBe(false)
      expect((await getRequest(db, id))?.modelId).toBeNull()
    })

    it('will not link to a model that has gone missing', async () => {
      expect(await findExactModelMatch(db, 'Vanished Model')).toBeNull()
    })

    it('does not second-guess a link the caller supplied', async () => {
      // The title names the dragon; the caller says it is the clip and wins.
      const { id, autoLinked } = await createRequest(
        db,
        { title: 'Articulated Dragon', modelId: CLIP },
        USER,
      )

      expect(autoLinked).toBe(false)
      expect((await getRequest(db, id))?.modelId).toBe(CLIP)
    })

    it('refuses a file that belongs to a different model', async () => {
      await expect(
        createRequest(db, { title: 'Clip', modelId: CLIP, modelFileId: dragonFileId }, USER),
      ).rejects.toBeInstanceOf(RequestValidationError)
    })

    it('accepts a file that belongs to the linked model', async () => {
      const { id } = await createRequest(
        db,
        { title: 'Clip', modelId: CLIP, modelFileId: clipFileId },
        USER,
      )
      expect((await getRequest(db, id))?.filename).toBe('clip.stl')
    })

    it('links and unlinks an existing request', async () => {
      const { id } = await createRequest(db, { title: 'A thing' }, USER)

      await linkRequest(db, id, DRAGON, dragonFileId)
      expect(await getRequest(db, id)).toMatchObject({
        modelId: DRAGON,
        modelFileId: dragonFileId,
      })

      // Dropping the model has to drop the file with it, or the row keeps a
      // file id the check constraint rejects on the next write.
      await linkRequest(db, id, null)
      expect(await getRequest(db, id)).toMatchObject({ modelId: null, modelFileId: null })
    })

    it('reports a linked model that has since gone missing', async () => {
      const { id } = await createRequest(db, { title: 'A thing', modelId: GONE }, USER)
      expect((await getRequest(db, id))?.modelMissing).toBe(true)
    })
  })

  describe('adding a batch', () => {
    it('creates one per line and links the ones it can', async () => {
      const lines = parseRequestLines('Articulated Dragon\nCable clip x4\nSomething unnameable')

      const result = await createRequests(
        db,
        lines.map((line) => ({ ...line, requestedBy: 'Sam' })),
        USER,
      )

      // Both real models are matched; "Something unnameable" is left unlinked.
      expect(result).toMatchObject({ created: 3, autoLinked: 2, failed: [] })

      const all = await listRequests(db)
      expect(all).toHaveLength(3)

      const clip = all.find((r) => r.title === 'Cable clip')
      expect(clip?.quantity).toBe(4)
      expect(clip?.modelId).toBe(CLIP)
      expect(all.find((r) => r.title === 'Something unnameable')?.modelId).toBeNull()
      expect(all.every((r) => r.requestedBy === 'Sam')).toBe(true)
    })

    /* One bad line should not cost the person the rest of the message. */
    it('keeps the good lines when one is rejected', async () => {
      const result = await createRequests(
        db,
        [{ title: 'Vase' }, { title: 'Bad', colorHex: 'not-a-colour' }, { title: 'Hook' }],
        USER,
      )

      expect(result.created).toBe(2)
      expect(result.failed).toHaveLength(1)
      expect(result.failed[0]?.title).toBe('Bad')
      expect((await listRequests(db)).map((r) => r.title).sort()).toEqual(['Hook', 'Vase'])
    })

    it('refuses more than the batch cap', async () => {
      const many = Array.from({ length: 51 }, (_, i) => ({ title: `Thing ${i}` }))
      await expect(createRequests(db, many, USER)).rejects.toBeInstanceOf(RequestValidationError)
    })
  })

  describe('working through the queue', () => {
    it('stamps closed_at on the way out and clears it on the way back', async () => {
      const { id } = await createRequest(db, { title: 'Vase' }, USER)

      await setRequestStatus(db, id, 'done')
      const done = await getRequest(db, id)
      expect(done?.status).toBe('done')
      expect(done?.closedAt).toBeInstanceOf(Date)

      // Marked done by mistake: reopening must not leave it both open and closed.
      await setRequestStatus(db, id, 'requested')
      const reopened = await getRequest(db, id)
      expect(reopened?.status).toBe('requested')
      expect(reopened?.closedAt).toBeNull()
    })

    it('leaves closed_at alone when moving between closed states', async () => {
      const { id } = await createRequest(db, { title: 'Vase' }, USER)

      await setRequestStatus(db, id, 'done')
      const first = (await getRequest(db, id))!.closedAt
      await setRequestStatus(db, id, 'cancelled')

      expect((await getRequest(db, id))?.closedAt?.getTime()).toBe(first?.getTime())
    })

    it('updates only the fields it is given', async () => {
      const { id } = await createRequest(db, { title: 'Vase', requestedBy: 'Nan' }, USER)

      await updateRequest(db, id, { quantity: 3, priority: 'high' })

      expect(await getRequest(db, id)).toMatchObject({
        title: 'Vase',
        requestedBy: 'Nan',
        quantity: 3,
        priority: 'high',
      })
    })

    it('treats an empty patch as a no-op rather than an error', async () => {
      const { id } = await createRequest(db, { title: 'Vase' }, USER)
      await expect(updateRequest(db, id, {})).resolves.toBeUndefined()
      expect((await getRequest(db, id))?.title).toBe('Vase')
    })

    it('deletes', async () => {
      const { id } = await createRequest(db, { title: 'Vase' }, USER)
      await deleteRequest(db, id)
      expect(await getRequest(db, id)).toBeNull()
    })
  })

  describe('ordering', () => {
    it('puts urgent work first, then whatever is due soonest', async () => {
      const soon = new Date(Date.now() + 60 * 60 * 1000)
      const later = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)

      await createRequest(db, { title: 'Low', priority: 'low' }, USER)
      await createRequest(db, { title: 'Normal, due later', dueAt: later }, USER)
      await createRequest(db, { title: 'Normal, due soon', dueAt: soon }, USER)
      await createRequest(db, { title: 'Urgent', priority: 'high' }, USER)

      expect((await listRequests(db)).map((r) => r.title)).toEqual([
        'Urgent',
        'Normal, due soon',
        'Normal, due later',
        'Low',
      ])
    })

    it('sinks closed requests below open ones', async () => {
      const { id } = await createRequest(db, { title: 'Finished', priority: 'high' }, USER)
      await createRequest(db, { title: 'Still waiting', priority: 'low' }, USER)
      await setRequestStatus(db, id, 'done')

      expect((await listRequests(db)).map((r) => r.title)).toEqual(['Still waiting', 'Finished'])
    })

    /* A finished list is a record, and a record reads newest first. */
    it('reads a closed-only list newest first', async () => {
      const first = await createRequest(db, { title: 'First' }, USER)
      await setRequestStatus(db, first.id, 'done')
      const second = await createRequest(db, { title: 'Second' }, USER)
      await setRequestStatus(db, second.id, 'done')

      const done = await listRequests(db, { status: ['done'] })
      expect(done.map((r) => r.title)).toEqual(['Second', 'First'])
    })

    it('filters by status', async () => {
      const { id } = await createRequest(db, { title: 'On the plate' }, USER)
      await createRequest(db, { title: 'Waiting' }, USER)
      await setRequestStatus(db, id, 'printing')

      const printing = await listRequests(db, { status: ['printing'] })
      expect(printing.map((r) => r.title)).toEqual(['On the plate'])
    })
  })

  describe('summaries', () => {
    it('counts each state and the overdue ones', async () => {
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)

      await createRequest(db, { title: 'Waiting' }, USER)
      await createRequest(db, { title: 'Late', dueAt: yesterday }, USER)
      const printing = await createRequest(db, { title: 'Printing' }, USER)
      await setRequestStatus(db, printing.id, 'printing')
      const done = await createRequest(db, { title: 'Done' }, USER)
      await setRequestStatus(db, done.id, 'done')

      expect(await queueStats(db)).toEqual({
        waiting: 2,
        printing: 1,
        done: 1,
        cancelled: 0,
        overdue: 1,
      })
    })

    /* A due date in the past on something already finished is not a problem. */
    it('does not count a closed request as overdue', async () => {
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
      const { id } = await createRequest(db, { title: 'Late but done', dueAt: yesterday }, USER)
      await setRequestStatus(db, id, 'done')

      expect((await queueStats(db)).overdue).toBe(0)
    })

    it('lists the open requests against one model', async () => {
      await createRequest(db, { title: 'Articulated Dragon' }, USER)
      const closed = await createRequest(db, { title: 'Articulated Dragon' }, USER)
      await setRequestStatus(db, closed.id, 'done')

      const open = await openRequestsForModel(db, DRAGON)
      expect(open).toHaveLength(1)
      expect(open[0]?.status).toBe('requested')
    })

    it('suggests the names that have asked most often', async () => {
      await createRequest(db, { title: 'A', requestedBy: 'Nan' }, USER)
      await createRequest(db, { title: 'B', requestedBy: 'Nan' }, USER)
      await createRequest(db, { title: 'C', requestedBy: 'Sam' }, USER)

      expect(await requesterSuggestions(db)).toEqual(['Nan', 'Sam'])
    })
  })
})
