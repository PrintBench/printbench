import { index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { libraries } from './libraries'
import { problemKind, problemSeverity, scanMode, scanStatus } from './enums'

/**
 * One execution of a library scan. Gives the UI live progress and leaves an
 * audit trail explaining why a scan aborted.
 */
export const scanRuns = pgTable(
  'scan_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    libraryId: uuid('library_id')
      .notNull()
      .references(() => libraries.id, { onDelete: 'cascade' }),
    status: scanStatus('status').notNull().default('queued'),
    mode: scanMode('mode').notNull().default('fast'),

    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),

    dirsWalked: integer('dirs_walked').notNull().default(0),
    filesSeen: integer('files_seen').notNull().default(0),
    modelsCreated: integer('models_created').notNull().default(0),
    modelsUpdated: integer('models_updated').notNull().default(0),
    modelsMissing: integer('models_missing').notNull().default(0),
    filesQueued: integer('files_queued').notNull().default(0),

    /**
     * Set when the scan refused to proceed — most importantly
     * 'mass_disappearance', which is how an unmounted NAS is stopped from
     * wiping the user's metadata.
     */
    abortReason: text('abort_reason'),
    errors: jsonb('errors'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('scan_runs_library_idx').on(t.libraryId, t.startedAt)],
)

/** A fixable issue found in the library. Powers the health dashboard. */
export const problems = pgTable(
  'problems',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: problemKind('kind').notNull(),
    severity: problemSeverity('severity').notNull().default('info'),
    modelId: uuid('model_id'),
    modelFileId: uuid('model_file_id'),
    /** Kind-specific payload, e.g. the other file ids sharing a digest. */
    detail: jsonb('detail'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    ignoredAt: timestamp('ignored_at', { withTimezone: true }),
  },
  (t) => [index('problems_kind_idx').on(t.kind), index('problems_model_idx').on(t.modelId)],
)

/** Site-wide key/value settings. Read-through cached, invalidated via NOTIFY. */
export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})
