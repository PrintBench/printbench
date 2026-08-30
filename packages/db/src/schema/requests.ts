import { sql } from 'drizzle-orm'
import { index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { printRequestPriority, printRequestStatus } from './enums'
import { user } from './auth'
import { modelFiles, models } from './models'
import { printRuns } from './prints'

/**
 * The print queue — things people have asked to have printed.
 *
 * Shared across the instance rather than per-user, unlike lists. A request is
 * addressed *to* whoever runs the printer, so a queue only one person can see
 * is the wrong shape: the housemate raises it, the owner works through it.
 *
 * `title` is free text and is the only required field, because the request
 * usually arrives before the file does — "something to hold the kitchen roll"
 * is a legitimate queue entry. `modelId` is the link to the library when one
 * exists, and stays null when it does not.
 */
export const printRequests = pgTable(
  'print_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** What was asked for, in the asker's words. */
    title: text('title').notNull(),
    notes: text('notes'),

    /**
     * Who asked, as free text. Most people who ask for a print do not have an
     * account here, so this is not a foreign key. `requestedByUserId` is set
     * as well when the asker did sign in and raise it themselves.
     */
    requestedBy: text('requested_by'),
    requestedByUserId: text('requested_by_user_id').references(() => user.id, {
      onDelete: 'set null',
    }),

    /**
     * The library link. `set null` rather than cascade: if the model is
     * removed the request is still outstanding, it just has nothing to point
     * at any more.
     */
    modelId: uuid('model_id').references(() => models.id, { onDelete: 'set null' }),
    /** The specific file to print, when the model has more than one. */
    modelFileId: uuid('model_file_id').references(() => modelFiles.id, { onDelete: 'set null' }),

    quantity: integer('quantity').notNull().default(1),
    priority: printRequestPriority('priority').notNull().default('normal'),
    status: printRequestStatus('status').notNull().default('requested'),

    /** Asked-for material and colour — "in red PLA" is half of most requests. */
    material: text('material'),
    colorHex: text('color_hex'),

    /**
     * The print history entry created when this was marked printed.
     *
     * Kept so the entry can be withdrawn again if the request is reopened.
     * `set null` because deleting the run by hand from the model page is
     * legitimate and should not take the request with it.
     */
    printRunId: uuid('print_run_id').references(() => printRuns.id, { onDelete: 'set null' }),

    dueAt: timestamp('due_at', { withTimezone: true }),
    /** Set when the request reaches `done` or `cancelled`. */
    closedAt: timestamp('closed_at', { withTimezone: true }),

    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The queue view: open requests, most urgent first. Descending on priority
    // because the enum sorts low -> high and the urgent end is the one read.
    index('print_requests_status_idx').on(t.status, t.priority.desc(), t.dueAt),
    // "What is queued for this model", shown on the model page. Partial: most
    // requests never name a model, and those rows are never looked up this way.
    index('print_requests_model_idx')
      .on(t.modelId)
      .where(sql`${t.modelId} IS NOT NULL`),
    index('print_requests_creator_idx').on(t.createdBy),
    // Only ever looked up from a request that has one, and most never will.
    index('print_requests_print_run_idx')
      .on(t.printRunId)
      .where(sql`${t.printRunId} IS NOT NULL`),
  ],
)
