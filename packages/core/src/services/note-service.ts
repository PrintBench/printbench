import { sql } from 'drizzle-orm'
import type { Database } from '@pb/db'

/**
 * Working notes against a model.
 *
 * The model's own `notes` column is its description: one field, overwritten
 * whenever someone edits the model, and written out to the sidecar. That is
 * the wrong shape for "the first one warped, I raised the bed to 65 and the
 * second was fine" — which needs a date, an author, and the entry before it
 * still being there.
 *
 * A note may point at a print run, and may equally point at nothing. Both are
 * ordinary: a problem is usually found on a specific print, and the lesson
 * drawn from it usually is not.
 *
 * Lives here rather than in a route handler so the rules hold for anything
 * that writes notes later — an importer, the worker, a future API.
 */

export const NOTE_MAX_LENGTH = 4000

export class NoteValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NoteValidationError'
  }
}

export interface ModelNote {
  id: string
  modelId: string
  /** Null when the note is about the model rather than one print. */
  printRunId: string | null
  /** Null when the author's account has been removed. */
  userId: string | null
  authorName: string | null
  body: string
  createdAt: Date
  updatedAt: Date
  /** Denormalised from the linked run so a list needs one query, not N. */
  printStatus: string | null
  printStartedAt: Date | null
  printCreatedAt: Date | null
}

export interface NoteInput {
  modelId: string
  body: string
  printRunId?: string | null
  userId?: string | null
}

function cleanBody(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length === 0) throw new NoteValidationError('A note needs something in it.')
  return trimmed.slice(0, NOTE_MAX_LENGTH)
}

/**
 * A print may only be linked from a note on the same model.
 *
 * Checked here rather than trusted from the form: the id arrives from the
 * browser, and a note filed under the wrong model would be invisible to the
 * person who wrote it.
 */
async function assertPrintBelongs(
  db: Database,
  modelId: string,
  printRunId: string,
): Promise<void> {
  const rows = await db.execute<{ ok: boolean }>(sql`
    SELECT true AS ok FROM print_runs WHERE id = ${printRunId} AND model_id = ${modelId} LIMIT 1
  `)
  if (rows.rows.length === 0) {
    throw new NoteValidationError('That print is not one of this model’s.')
  }
}

export async function createNote(db: Database, input: NoteInput): Promise<string> {
  const body = cleanBody(input.body)
  const printRunId = input.printRunId || null

  if (printRunId) await assertPrintBelongs(db, input.modelId, printRunId)

  const rows = await db.execute<{ id: string }>(sql`
    INSERT INTO model_notes (model_id, print_run_id, user_id, body)
    VALUES (${input.modelId}, ${printRunId}, ${input.userId ?? null}, ${body})
    RETURNING id
  `)

  return rows.rows[0]!.id
}

export interface NotePatch {
  body?: string
  /** Null unlinks the note from its print; undefined leaves the link alone. */
  printRunId?: string | null
}

export async function updateNote(db: Database, noteId: string, patch: NotePatch): Promise<void> {
  const current = await getNoteOwner(db, noteId)
  if (!current) throw new NoteValidationError('That note no longer exists.')

  const sets = []

  if (patch.body !== undefined) sets.push(sql`body = ${cleanBody(patch.body)}`)

  if (patch.printRunId !== undefined) {
    if (patch.printRunId) await assertPrintBelongs(db, current.modelId, patch.printRunId)
    sets.push(sql`print_run_id = ${patch.printRunId || null}`)
  }

  if (sets.length === 0) return

  sets.push(sql`updated_at = now()`)

  await db.execute(sql`
    UPDATE model_notes SET ${sql.join(sets, sql`, `)} WHERE id = ${noteId}
  `)
}

export async function deleteNote(db: Database, noteId: string): Promise<void> {
  await db.execute(sql`DELETE FROM model_notes WHERE id = ${noteId}`)
}

/**
 * Who wrote a note and what it hangs off.
 *
 * Read before an edit or a delete so the caller can authorize against the
 * author rather than the role alone.
 */
export async function getNoteOwner(
  db: Database,
  noteId: string,
): Promise<{ modelId: string; userId: string | null } | null> {
  const rows = await db.execute<{ model_id: string; user_id: string | null }>(sql`
    SELECT model_id, user_id FROM model_notes WHERE id = ${noteId} LIMIT 1
  `)
  const row = rows.rows[0]
  return row ? { modelId: row.model_id, userId: row.user_id } : null
}

export async function listNotes(
  db: Database,
  modelId: string,
  options: { limit?: number } = {},
): Promise<ModelNote[]> {
  const limit = Math.min(Math.max(options.limit ?? 200, 1), 500)

  const rows = await db.execute<{
    id: string
    model_id: string
    print_run_id: string | null
    user_id: string | null
    author_name: string | null
    body: string
    // Raw rows arrive as strings; converted below, as print-service does.
    created_at: string
    updated_at: string
    print_status: string | null
    print_started_at: string | null
    print_created_at: string | null
  }>(sql`
    SELECT n.id, n.model_id, n.print_run_id, n.user_id, u.name AS author_name,
           n.body, n.created_at, n.updated_at,
           p.status AS print_status, p.started_at AS print_started_at,
           p.created_at AS print_created_at
    FROM model_notes n
    LEFT JOIN "user" u ON u.id = n.user_id
    LEFT JOIN print_runs p ON p.id = n.print_run_id
    WHERE n.model_id = ${modelId}
    ORDER BY n.created_at DESC, n.id DESC
    LIMIT ${limit}
  `)

  return rows.rows.map((row) => ({
    id: row.id,
    modelId: row.model_id,
    printRunId: row.print_run_id,
    userId: row.user_id,
    authorName: row.author_name,
    body: row.body,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    printStatus: row.print_status,
    printStartedAt: row.print_started_at ? new Date(row.print_started_at) : null,
    printCreatedAt: row.print_created_at ? new Date(row.print_created_at) : null,
  }))
}
