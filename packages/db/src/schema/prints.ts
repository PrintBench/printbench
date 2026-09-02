import {
  boolean,
  index,
  integer,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'
import { bedAdhesion, nozzleType, printHostProtocol, printStatus } from './enums'
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
    /* Diameter and material are separate questions; only one of them ruins a hot end. */
    nozzleType: nozzleType('nozzle_type'),

    /* Which spool, and what it cost. Cost is a bare number: a self-hosted
     * instance has one owner and therefore one currency. */
    filamentBrand: text('filament_brand'),
    colorName: text('color_name'),
    filamentCost: numeric('filament_cost', { precision: 10, scale: 2 }),

    /* What the slicer was asked to do. Every one of these is nullable because
     * a print logged by hand legitimately does not know them, and a guessed
     * value is worse than an empty one. */
    infillPercent: smallint('infill_percent'),
    wallCount: smallint('wall_count'),
    /** Null is unknown; false is a deliberate "no supports". */
    supports: boolean('supports'),
    adhesion: bedAdhesion('adhesion'),
    nozzleTempC: smallint('nozzle_temp_c'),
    bedTempC: smallint('bed_temp_c'),
    slicerName: text('slicer_name'),
    slicerVersion: text('slicer_version'),
    /** The named profile inside the slicer, e.g. "0.20mm Standard @BBL X1C". */
    slicerProfile: text('slicer_profile'),

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
