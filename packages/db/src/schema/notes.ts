import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { models } from './models'
import { printRuns } from './prints'
import { user } from './auth'

/**
 * Working notes against a model: what went wrong, what fixed it, what to
 * remember next time.
 *
 * Separate from `models.notes`, which is the model's description — one field,
 * overwritten on every edit, and shared with the sidecar. A workshop log is
 * append-mostly and needs an author and a date per entry, so it is its own
 * table rather than more text in that column.
 *
 * `printRunId` is nullable on purpose. A note about a specific print ("warped
 * at 40mm, raised the bed temp") belongs to that run; a note about the model
 * itself ("print the hinge face down") belongs to no run at all, and forcing
 * one would mean inventing a print that never happened.
 */
export const modelNotes = pgTable(
  'model_notes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    modelId: uuid('model_id')
      .notNull()
      .references(() => models.id, { onDelete: 'cascade' }),
    /**
     * The print this note is about, when it is about one.
     *
     * Set null rather than cascade: deleting a print from the history should
     * not silently destroy what someone wrote about fixing it.
     */
    printRunId: uuid('print_run_id').references(() => printRuns.id, { onDelete: 'set null' }),
    /** Null once the author's account is removed; the note itself stays. */
    userId: text('user_id').references(() => user.id, { onDelete: 'set null' }),

    body: text('body').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The model page reads every note for one model, newest first.
    index('model_notes_model_idx').on(t.modelId, t.createdAt),
    // Print history shows the notes attached to each run.
    index('model_notes_print_idx').on(t.printRunId),
  ],
)
