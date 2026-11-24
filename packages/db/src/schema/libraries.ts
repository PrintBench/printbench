import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core'
import { groupingMode, libraryKind, libraryRemovalMode, storageBackend } from './enums'

/**
 * One bucket and the credentials that reach it, shared by any number of
 * libraries.
 *
 * Held apart from `libraries` so that one bucket carved into several libraries
 * (by prefix) is configured once, and a key that is rotated or revoked changes
 * in one row rather than in every library that happened to copy it.
 *
 * The bucket lives here rather than on the library because a connection is
 * what an admin hands out: "this key, for that bucket". A library only picks a
 * prefix within it.
 */
export const s3Connections = pgTable(
  's3_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    bucket: text('bucket').notNull(),
    endpoint: text('endpoint'),
    region: text('region'),
    /** Null for both means the SDK's own credential chain (an instance role, say). */
    accessKeyId: text('access_key_id'),
    /** Encrypted at rest by packages/core/security/secret-box. */
    secretAccessKey: text('secret_access_key'),
    forcePathStyle: boolean('force_path_style').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('s3_connections_name_idx').on(t.name)],
)

/**
 * A storage root that gets indexed. Either a directory the user already owns
 * (`in_place`, read-only) or one the app owns and writes uploads into
 * (`managed`).
 */
export const libraries = pgTable(
  'libraries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    kind: libraryKind('kind').notNull().default('in_place'),
    backend: storageBackend('backend').notNull().default('local'),

    /** Absolute root path, as seen by the container. Local backend only. */
    path: text('path'),

    /**
     * S3 backend: the bucket and credentials. Restrict, not cascade or set
     * null — removing a connection must never silently orphan a library.
     */
    s3ConnectionId: uuid('s3_connection_id').references(() => s3Connections.id, {
      onDelete: 'restrict',
    }),
    /** S3 backend: the folder within the connection's bucket that is indexed. */
    s3Prefix: text('s3_prefix'),

    /**
     * Escape hatch allowing writes into an in-place library. Off by default:
     * the promise is that we never touch the user's files.
     */
    allowWrites: boolean('allow_writes').notNull().default(false),

    /** Write a .printbench.json sidecar per model so metadata survives DB loss. */
    writeSidecar: boolean('write_sidecar').notNull().default(true),

    scanEnabled: boolean('scan_enabled').notNull().default(true),
    scanCron: text('scan_cron'),
    lastScanId: uuid('last_scan_id'),

    /**
     * Live filesystem watching, on top of the scan schedule. Off by default:
     * recursive watching burns one inotify watch per directory and can exceed
     * fs.inotify.max_user_watches on a large library. Local backend only —
     * there is no filesystem to watch on S3.
     */
    watchEnabled: boolean('watch_enabled').notNull().default(false),

    groupingMode: groupingMode('grouping_mode').notNull().default('deepest'),
    groupingDepth: integer('grouping_depth'),

    /**
     * Set while the worker is removing this library: deleting its files, or
     * moving its models elsewhere first. Scans, uploads and moves skip a
     * library in this state. Cleared again if the removal stops part-way,
     * with the reason in `removalError`; the row itself goes once it succeeds.
     */
    removalMode: libraryRemovalMode('removal_mode'),
    /** Where a `move` removal sends the models. */
    removalDestinationId: uuid('removal_destination_id').references(
      (): AnyPgColumn => libraries.id,
      { onDelete: 'set null' },
    ),
    removalRequestedAt: timestamp('removal_requested_at', { withTimezone: true }),
    /** Why the last removal stopped before finishing, for the admin to act on. */
    removalError: text('removal_error'),

    /** Meshes are Z-up by convention; some sources are Y-up. Per-file overridable. */
    defaultYUp: boolean('default_y_up').notNull().default(false),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('libraries_path_idx').on(t.path),
    index('libraries_s3_connection_idx').on(t.s3ConnectionId),
  ],
)

/**
 * Per-directory index used to prune fast scans: if a directory's mtime and
 * entry count are unchanged we skip descending into it entirely.
 *
 * Caveat: directory mtime changes when entries are added, removed or renamed —
 * NOT when an existing file's bytes change. A deep scan catches those.
 */
export const libraryDirs = pgTable(
  'library_dirs',
  {
    libraryId: uuid('library_id')
      .notNull()
      .references(() => libraries.id, { onDelete: 'cascade' }),
    /** POSIX separators, NFC-normalized, relative to the library root. */
    relPath: text('rel_path').notNull(),
    mtimeMs: bigint('mtime_ms', { mode: 'number' }),
    entryCount: integer('entry_count').notNull().default(0),
    isModelRoot: boolean('is_model_root').notNull().default(false),
    modelId: uuid('model_id'),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    primaryKey({ columns: [t.libraryId, t.relPath] }),
    index('library_dirs_model_idx').on(t.modelId),
  ],
)
