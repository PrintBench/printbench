import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { tsvector } from './columns'
import { derivedState, fileCategory } from './enums'
import { libraries } from './libraries'
import { creators } from './creators'

/**
 * A "thing you print" — normally one folder, occasionally a single loose file.
 * The hub of the schema.
 */
export const models = pgTable(
  'models',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    libraryId: uuid('library_id')
      .notNull()
      .references(() => libraries.id, { onDelete: 'cascade' }),

    /** POSIX separators, NFC-normalized, relative to the library root. */
    path: text('path').notNull(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    /** Short opaque id for share links; not guessable from the row id. */
    publicId: text('public_id').notNull(),

    notes: text('notes'),
    /** SPDX identifier, e.g. 'CC-BY-4.0'. Null means unknown, not unlicensed. */
    license: text('license'),

    creatorId: uuid('creator_id').references(() => creators.id, { onDelete: 'set null' }),
    /** FK to model_files, added by migration once both tables exist (circular). */
    previewFileId: uuid('preview_file_id'),

    /** True when this model is a single loose file rather than a folder. */
    isFileModel: boolean('is_file_model').notNull().default(false),

    // Denormalized for sorting and grid badges without a join.
    fileCount: integer('file_count').notNull().default(0),
    totalSize: bigint('total_size', { mode: 'number' }).notNull().default(0),

    dirMtimeMs: bigint('dir_mtime_ms', { mode: 'number' }),

    lastSeenAt: timestamp('last_seen_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    /** Soft delete. Set when a scan no longer finds it; hard-deleted after a grace period. */
    missingAt: timestamp('missing_at', { withTimezone: true }),

    /**
     * Set when this model is shared by link, cleared to revoke.
     *
     * A separate secret from publicId, which is already the internal URL
     * segment and so is known to everyone who can see the model at all.
     */
    shareToken: text('share_token'),
    sharedAt: timestamp('shared_at', { withTimezone: true }),
    sharedBy: text('shared_by'),

    searchVector: tsvector('search_vector'),
    /** When search_vector was last rebuilt; drives the nightly drift sweep. */
    indexedAt: timestamp('indexed_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('models_library_path_uq').on(t.libraryId, t.path),
    uniqueIndex('models_public_id_uq').on(t.publicId),
    index('models_creator_idx').on(t.creatorId),
    index('models_library_idx').on(t.libraryId),
  ],
)

/** An individual file inside a model folder. */
export const modelFiles = pgTable(
  'model_files',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    modelId: uuid('model_id')
      .notNull()
      .references(() => models.id, { onDelete: 'cascade' }),

    /** POSIX, relative to the model directory; may include subfolders. */
    filename: text('filename').notNull(),
    /** Lowercased, no leading dot. */
    extension: text('extension').notNull(),
    mediaType: text('media_type'),
    category: fileCategory('category').notNull().default('other'),

    size: bigint('size', { mode: 'number' }).notNull().default(0),
    mtimeMs: bigint('mtime_ms', { mode: 'number' }),
    /** S3 ETag, used for change detection where mtime is unavailable. */
    etag: text('etag'),
    /** sha256 hex. Null until computed; only recomputed when size/mtime change. */
    digest: text('digest'),

    /** File already includes print supports (detected from its name or path). */
    presupported: boolean('presupported').notNull().default(false),
    yUp: boolean('y_up').notNull().default(false),
    /** We have a parser for this format, so a thumbnail and viewer are possible. */
    previewable: boolean('previewable').notNull().default(false),

    triangleCount: integer('triangle_count'),
    bboxX: numeric('bbox_x', { precision: 12, scale: 4 }),
    bboxY: numeric('bbox_y', { precision: 12, scale: 4 }),
    bboxZ: numeric('bbox_z', { precision: 12, scale: 4 }),
    bboxUnit: text('bbox_unit').default('mm'),
    manifold: boolean('manifold'),

    /** Content-addressed key under DATA_DIR/previews, includes RENDERER_VERSION. */
    thumbKey: text('thumb_key'),
    thumbState: derivedState('thumb_state').notNull().default('pending'),
    thumbError: text('thumb_error'),
    analysisState: derivedState('analysis_state').notNull().default('pending'),
    analysisError: text('analysis_error'),

    lastSeenAt: timestamp('last_seen_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    missingAt: timestamp('missing_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('model_files_model_filename_uq').on(t.modelId, t.filename),
    index('model_files_category_idx').on(t.modelId, t.category),
  ],
)
