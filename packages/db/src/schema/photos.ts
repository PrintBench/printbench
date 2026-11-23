import { index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { models } from './models'
import { printRuns } from './prints'
import { user } from './auth'

/**
 * Photographs of what actually came off the plate.
 *
 * Nothing like model_files: those are indexed from a library folder and are
 * whatever the creator shipped. These are uploaded by the people running the
 * instance, live under DATA_DIR rather than in a library — most libraries are
 * mounted read-only, and writing holiday snaps into someone's model folder
 * would be wrong even where it is possible — and cannot be regenerated, so
 * they go into backups where generated thumbnails deliberately do not.
 *
 * Both keys point into the photo store. The display rendition and the grid
 * thumbnail are separate objects so a wall of twelve photos does not pull
 * twelve full-size images.
 *
 * `printRunId` is nullable for the same reason model_notes' is: a photo of the
 * finished thing belongs to the model, and only some photos are evidence about
 * one particular run.
 */
export const modelPhotos = pgTable(
  'model_photos',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    modelId: uuid('model_id')
      .notNull()
      .references(() => models.id, { onDelete: 'cascade' }),
    /**
     * Set null rather than cascade: deleting a print from the history should
     * not throw away the photograph of what it produced.
     */
    printRunId: uuid('print_run_id').references(() => printRuns.id, { onDelete: 'set null' }),
    /** Null once the uploader's account is removed; the photo itself stays. */
    userId: text('user_id').references(() => user.id, { onDelete: 'set null' }),

    caption: text('caption'),

    /** Keys into the photo store under DATA_DIR. Both are WebP. */
    imageKey: text('image_key').notNull(),
    thumbKey: text('thumb_key').notNull(),
    /** Of the display rendition, so the grid can reserve the right space. */
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    byteSize: integer('byte_size').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('model_photos_model_idx').on(t.modelId, t.createdAt),
    index('model_photos_print_idx').on(t.printRunId),
  ],
)
