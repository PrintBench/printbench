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
  uuid,
} from 'drizzle-orm/pg-core'
import { groupingMode, libraryKind, storageBackend } from './enums'

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

    // S3 backend. Credentials are encrypted at rest by packages/core/crypto.
    s3Bucket: text('s3_bucket'),
    s3Prefix: text('s3_prefix'),
    s3Endpoint: text('s3_endpoint'),
    s3Region: text('s3_region'),
    s3AccessKeyId: text('s3_access_key_id'),
    s3SecretAccessKey: text('s3_secret_access_key'),
    s3ForcePathStyle: boolean('s3_force_path_style').notNull().default(true),

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

    /** Meshes are Z-up by convention; some sources are Y-up. Per-file overridable. */
    defaultYUp: boolean('default_y_up').notNull().default(false),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('libraries_path_idx').on(t.path)],
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
