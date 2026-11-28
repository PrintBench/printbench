import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'
import { s3Connections } from './libraries'

/**
 * Scheduled, encrypted backups to a bucket. One row or none: there is one
 * schedule per instance.
 *
 * The connection is `restrict`, like a library's, so the bucket backups are
 * going to cannot be removed out from under them.
 */
export const backupSchedule = pgTable(
  'backup_schedule',
  {
    /** Always 1. The check is what makes this table a single row. */
    id: smallint('id').primaryKey().default(1),
    enabled: boolean('enabled').notNull().default(true),
    s3ConnectionId: uuid('s3_connection_id')
      .notNull()
      .references(() => s3Connections.id, { onDelete: 'restrict' }),
    /** Normalised: no leading or trailing slash. Never the whole bucket. */
    prefix: text('prefix').notNull(),
    /** Cron, in the server's local time, like library scan schedules. */
    cron: text('cron').notNull(),
    keep: integer('keep').notNull().default(14),

    /**
     * The X25519 key backups are encrypted for, and its private half sealed
     * under the admin's passphrase. The passphrase itself is never stored, so
     * this instance can write backups and not read them. See
     * packages/core/src/backup/envelope.ts.
     */
    keyId: text('key_id').notNull(),
    publicKey: text('public_key').notNull(),
    sealedPrivateKey: jsonb('sealed_private_key').notNull(),
    keyCreatedAt: timestamp('key_created_at', { withTimezone: true }).notNull().defaultNow(),

    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('backup_schedule_single_row', sql`${t.id} = 1`)],
)

/**
 * One attempt at a scheduled or on-demand backup.
 *
 * Left out of backups themselves, like process_status: it describes what this
 * machine did, and a restored copy would show runs — one of them still
 * "running" — that never happened on the instance it is restored to. The
 * bucket listing, not this table, is the record of which backups exist.
 */
export const backupRuns = pgTable(
  'backup_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    trigger: text('trigger', { enum: ['schedule', 'manual'] }).notNull(),
    status: text('status', { enum: ['running', 'succeeded', 'failed'] })
      .notNull()
      .default('running'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    /** Relative to the schedule's prefix. */
    objectName: text('object_name'),
    bytes: bigint('bytes', { mode: 'number' }),
    pruned: integer('pruned').notNull().default(0),
    keyId: text('key_id'),
    error: text('error'),
    /** Who pressed "Back up now"; null for the schedule. */
    requestedBy: text('requested_by'),
  },
  (t) => [index('backup_runs_started_idx').on(t.startedAt)],
)

/**
 * Which installation this is. One row, made on first use.
 *
 * Scheduled backups go under a folder named for it, so two instances pointed
 * at the same bucket prefix — an old server and the new one restored from
 * its backup, say — never prune each other's backups.
 *
 * It belongs to the machine, not the data: it is left out of backups, and a
 * restore keeps the identity of the instance it restores onto. Restoring onto
 * the same server therefore carries on in the same folder, and a new server
 * starts one of its own.
 */
export const instanceIdentity = pgTable(
  'instance_identity',
  {
    /** Always 1. */
    id: smallint('id').primaryKey().default(1),
    instanceId: uuid('instance_id').notNull().defaultRandom(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('instance_identity_single_row', sql`${t.id} = 1`)],
)
