import {
  index,
  integer,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'
import { printHostProtocol, printStatus } from './enums'
import { user } from './auth'

/**
 * Print history — a log of actual prints against a model. Drives "printed 3x,
 * last on 12 Aug", the never-printed filter, and per-model success rates.
 */
export const printRuns = pgTable(
  'print_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    modelId: uuid('model_id').notNull(),
    /** Which file was actually printed, when known. */
    modelFileId: uuid('model_file_id'),
    userId: text('user_id').references(() => user.id, { onDelete: 'set null' }),

    printerName: text('printer_name'),
    material: text('material'),
    colorHex: text('color_hex'),
    layerHeightMm: numeric('layer_height_mm', { precision: 5, scale: 3 }),
    nozzleMm: numeric('nozzle_mm', { precision: 4, scale: 2 }),

    status: printStatus('status').notNull().default('success'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    durationMin: integer('duration_min'),
    filamentUsedG: numeric('filament_used_g', { precision: 10, scale: 2 }),

    /** 1-5, the user's own verdict on how it came out. */
    rating: smallint('rating'),
    notes: text('notes'),
    photoKey: text('photo_key'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('print_runs_model_idx').on(t.modelId, t.startedAt),
    index('print_runs_user_idx').on(t.userId),
  ],
)

/** A networked printer we can push a sliced file to. */
export const printHosts = pgTable('print_hosts', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  protocol: printHostProtocol('protocol').notNull(),
  endpoint: text('endpoint').notNull(),
  /** Encrypted at rest by packages/core/crypto. */
  credentials: text('credentials'),
  lastSeenOk: timestamp('last_seen_ok', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})
