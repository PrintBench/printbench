import {
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { user } from './auth'
import { printRuns } from './prints'

export interface FilamentSnapshot {
  name: string
  brand: string | null
  material: string
  colorName: string | null
  colorHex: string | null
  diameterMm: number
  nozzleTempC: number | null
  bedTempC: number | null
  spoolLabel: string | null
}

export const filaments = pgTable('filaments', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  brand: text('brand'),
  material: text('material').notNull(),
  colorName: text('color_name'),
  colorHex: text('color_hex'),
  diameterMm: numeric('diameter_mm', { precision: 5, scale: 2 }).notNull().default('1.75'),
  nozzleTempC: numeric('nozzle_temp_c', { precision: 5, scale: 1 }),
  bedTempC: numeric('bed_temp_c', { precision: 5, scale: 1 }),
  notes: text('notes'),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const filamentSpools = pgTable(
  'filament_spools',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    filamentId: uuid('filament_id')
      .notNull()
      .references(() => filaments.id),
    label: text('label'),
    nominalWeightG: numeric('nominal_weight_g', { precision: 10, scale: 2 })
      .notNull()
      .default('1000'),
    emptyWeightG: numeric('empty_weight_g', { precision: 10, scale: 2 }),
    purchaseCost: numeric('purchase_cost', { precision: 10, scale: 2 }),
    location: text('location'),
    notes: text('notes'),
    lowStockG: numeric('low_stock_g', { precision: 10, scale: 2 }).notNull().default('100'),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('filament_spools_filament_idx').on(t.filamentId)],
)

export const printFilamentUsage = pgTable(
  'print_filament_usage',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    printRunId: uuid('print_run_id')
      .notNull()
      .references(() => printRuns.id, { onDelete: 'cascade' }),
    spoolId: uuid('spool_id')
      .notNull()
      .references(() => filamentSpools.id),
    grams: numeric('grams', { precision: 10, scale: 2 }).notNull(),
    snapshot: jsonb('snapshot').$type<FilamentSnapshot>().notNull(),
    costPerGram: numeric('cost_per_gram', { precision: 16, scale: 8 }),
  },
  (t) => [
    uniqueIndex('print_filament_usage_run_spool_idx').on(t.printRunId, t.spoolId),
    index('print_filament_usage_spool_idx').on(t.spoolId),
  ],
)

/** Append-only deltas survive print deletion; their sum is the current balance. */
export const filamentStockChanges = pgTable(
  'filament_stock_changes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    spoolId: uuid('spool_id')
      .notNull()
      .references(() => filamentSpools.id),
    amountG: numeric('amount_g', { precision: 10, scale: 2 }).notNull(),
    kind: text('kind').$type<'opening' | 'correction' | 'consumption' | 'reversal'>().notNull(),
    reason: text('reason').notNull(),
    printRunId: uuid('print_run_id'),
    actorId: text('actor_id').references(() => user.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('filament_stock_changes_spool_idx').on(t.spoolId, t.createdAt)],
)
