import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { createDb } from '@pb/db'
import { logPrint } from './print-service'
import {
  NOTE_MAX_LENGTH,
  NoteValidationError,
  createNote,
  deleteNote,
  getNoteOwner,
  listNotes,
  updateNote,
} from './note-service'

/**
 * Model notes.
 *
 * The two things worth pinning down are the ones a route handler cannot be
 * trusted with: that a note may exist with no print attached, and that a note
 * cannot be attached to a print belonging to a different model. The second is
 * a quiet failure — the note would simply never appear where it was written.
 */

const url = process.env.DATABASE_URL

const LIB = '7e000000-0000-4000-8000-000000000001'
const MODEL = '7eaa0000-0000-4000-8000-00000000000a'
const OTHER = '7eaa0000-0000-4000-8000-00000000000b'
const USER = 'note-test-user'

describe('model notes', { tags: ['integration'] }, () => {
  let pool: ReturnType<typeof createDb>['pool']
  let db: ReturnType<typeof createDb>['db']

  beforeAll(async () => {
    ;({ pool, db } = createDb(url))
    await cleanup()

    await db.execute(sql`
      INSERT INTO "user" (id, name, email, email_verified)
      VALUES (${USER}, 'Note Tester', 'note-tester@example.test', true)`)

    await db.execute(sql`
      INSERT INTO libraries (id, name, kind, backend, path)
      VALUES (${LIB}, 'Note Fixture', 'in_place', 'local', '/fixtures/notes')`)

    for (const [id, suffix, name] of [
      [MODEL, 'a', 'Noted Model'],
      [OTHER, 'b', 'Other Model'],
    ] as [string, string, string][]) {
      await db.execute(sql`
        INSERT INTO models (id, library_id, path, name, slug, public_id, file_count, total_size)
        VALUES (${id}, ${LIB}, ${'n/' + suffix}, ${name}, ${'n-' + suffix},
                ${'mdn00000000' + suffix}, 1, 1000)`)
    }
  })

  beforeEach(async () => {
    await db.execute(sql`DELETE FROM model_notes WHERE model_id IN (${MODEL}, ${OTHER})`)
    await db.execute(sql`DELETE FROM print_runs WHERE model_id IN (${MODEL}, ${OTHER})`)
  })

  afterAll(async () => {
    await cleanup()
    await pool.end()
  })

  async function cleanup() {
    await db.execute(sql`DELETE FROM model_notes WHERE model_id IN (${MODEL}, ${OTHER})`)
    await db.execute(sql`DELETE FROM print_runs WHERE model_id IN (${MODEL}, ${OTHER})`)
    await db.execute(sql`DELETE FROM models WHERE library_id = ${LIB}`)
    await db.execute(sql`DELETE FROM libraries WHERE id = ${LIB}`)
    await db.execute(sql`DELETE FROM "user" WHERE id = ${USER}`)
  }

  describe('writing', () => {
    it('keeps a note that is about no print at all', async () => {
      await createNote(db, {
        modelId: MODEL,
        userId: USER,
        body: '  Print the hinge face down.  ',
      })

      const notes = await listNotes(db, MODEL)
      expect(notes).toHaveLength(1)
      expect(notes[0]).toMatchObject({
        body: 'Print the hinge face down.',
        printRunId: null,
        authorName: 'Note Tester',
      })
    })

    it('attaches a note to a print of the same model', async () => {
      const { id: printId } = await logPrint(db, { modelId: MODEL, status: 'failed' })

      await createNote(db, {
        modelId: MODEL,
        userId: USER,
        body: 'Warped at 40mm. Raised the bed to 65 and it held.',
        printRunId: printId,
      })

      const notes = await listNotes(db, MODEL)
      expect(notes[0]).toMatchObject({ printRunId: printId, printStatus: 'failed' })
    })

    /*
     * The id comes from a form, so it is whatever the browser sent. A note
     * filed against another model's print would vanish from the page it was
     * written on, and nobody would report it as a bug.
     */
    it('refuses a print belonging to another model', async () => {
      const { id: elsewhere } = await logPrint(db, { modelId: OTHER })

      await expect(
        createNote(db, { modelId: MODEL, body: 'Nope', printRunId: elsewhere }),
      ).rejects.toThrow(NoteValidationError)

      expect(await listNotes(db, MODEL)).toHaveLength(0)
    })

    it('refuses an empty note', async () => {
      await expect(createNote(db, { modelId: MODEL, body: '   \n  ' })).rejects.toThrow(
        NoteValidationError,
      )
    })

    it('truncates rather than rejecting an overlong note', async () => {
      await createNote(db, { modelId: MODEL, body: 'x'.repeat(NOTE_MAX_LENGTH + 500) })
      const notes = await listNotes(db, MODEL)
      expect(notes[0]!.body).toHaveLength(NOTE_MAX_LENGTH)
    })
  })

  describe('editing', () => {
    it('changes the body and moves the timestamp', async () => {
      const id = await createNote(db, { modelId: MODEL, userId: USER, body: 'First thought' })
      const before = (await listNotes(db, MODEL))[0]!

      await updateNote(db, id, { body: 'Second thought' })

      const after = (await listNotes(db, MODEL))[0]!
      expect(after.body).toBe('Second thought')
      expect(after.updatedAt.getTime()).toBeGreaterThanOrEqual(before.updatedAt.getTime())
      expect(after.createdAt.getTime()).toBe(before.createdAt.getTime())
    })

    it('unlinks a note from its print without deleting either', async () => {
      const { id: printId } = await logPrint(db, { modelId: MODEL })
      const id = await createNote(db, { modelId: MODEL, body: 'Linked', printRunId: printId })

      await updateNote(db, id, { printRunId: null })

      expect((await listNotes(db, MODEL))[0]!.printRunId).toBeNull()
    })

    it('leaves the link alone when the patch does not mention it', async () => {
      const { id: printId } = await logPrint(db, { modelId: MODEL })
      const id = await createNote(db, { modelId: MODEL, body: 'Linked', printRunId: printId })

      await updateNote(db, id, { body: 'Still linked' })

      expect((await listNotes(db, MODEL))[0]!.printRunId).toBe(printId)
    })

    it('refuses to move a note onto another model print', async () => {
      const { id: elsewhere } = await logPrint(db, { modelId: OTHER })
      const id = await createNote(db, { modelId: MODEL, body: 'Mine' })

      await expect(updateNote(db, id, { printRunId: elsewhere })).rejects.toThrow(
        NoteValidationError,
      )
    })
  })

  describe('authorship', () => {
    it('reports the author so a caller can authorize against them', async () => {
      const id = await createNote(db, { modelId: MODEL, userId: USER, body: 'Mine' })
      expect(await getNoteOwner(db, id)).toEqual({ modelId: MODEL, userId: USER })
    })

    it('has no owner for a note that is gone', async () => {
      const id = await createNote(db, { modelId: MODEL, body: 'Briefly' })
      await deleteNote(db, id)
      expect(await getNoteOwner(db, id)).toBeNull()
    })
  })

  /*
   * Deleting a print should not destroy what someone wrote about fixing it —
   * that note is often the only record of why the next print worked.
   */
  it('keeps a note when its print is deleted, and drops the link', async () => {
    const { id: printId } = await logPrint(db, { modelId: MODEL })
    await createNote(db, { modelId: MODEL, body: 'Bed was filthy', printRunId: printId })

    await db.execute(sql`DELETE FROM print_runs WHERE id = ${printId}`)

    const notes = await listNotes(db, MODEL)
    expect(notes).toHaveLength(1)
    expect(notes[0]).toMatchObject({ body: 'Bed was filthy', printRunId: null })
  })

  it('lists the newest note first', async () => {
    await createNote(db, { modelId: MODEL, body: 'Older' })
    await createNote(db, { modelId: MODEL, body: 'Newer' })

    expect((await listNotes(db, MODEL)).map((note) => note.body)).toEqual(['Newer', 'Older'])
  })
})
