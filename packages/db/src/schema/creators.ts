import {
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { tsvector } from './columns'

/** The designer of a model. */
export const creators = pgTable(
  'creators',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    publicId: text('public_id').notNull(),
    notes: text('notes'),
    avatarKey: text('avatar_key'),
    searchVector: tsvector('search_vector'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('creators_slug_uq').on(t.slug),
    uniqueIndex('creators_public_id_uq').on(t.publicId),
  ],
)

/** Nestable grouping — a Kickstarter drop, a game system, a themed set. */
export const collections = pgTable(
  'collections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    publicId: text('public_id').notNull(),
    caption: text('caption'),
    notes: text('notes'),
    /** Self-reference. Cycle prevention is enforced in the service layer. */
    parentId: uuid('parent_id'),
    creatorId: uuid('creator_id').references(() => creators.id, { onDelete: 'set null' }),
    previewModelId: uuid('preview_model_id'),
    searchVector: tsvector('search_vector'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('collections_slug_uq').on(t.slug),
    uniqueIndex('collections_public_id_uq').on(t.publicId),
    index('collections_parent_idx').on(t.parentId),
  ],
)

export const collectionModels = pgTable(
  'collection_models',
  {
    collectionId: uuid('collection_id')
      .notNull()
      .references(() => collections.id, { onDelete: 'cascade' }),
    modelId: uuid('model_id').notNull(),
    position: integer('position').notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.collectionId, t.modelId] }),
    index('collection_models_model_idx').on(t.modelId),
  ],
)

/**
 * Tags use real FK join tables rather than a polymorphic `taggings` table.
 * Polymorphic associations are a Rails idiom; in Postgres they cost referential
 * integrity, cascade deletes and index quality on the tag -> models join, which
 * is the one we run most.
 */
export const tags = pgTable(
  'tags',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    color: text('color'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('tags_slug_uq').on(t.slug)],
)

export const modelTags = pgTable(
  'model_tags',
  {
    modelId: uuid('model_id').notNull(),
    tagId: uuid('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.modelId, t.tagId] }),
    index('model_tags_tag_idx').on(t.tagId, t.modelId),
  ],
)

export const creatorTags = pgTable(
  'creator_tags',
  {
    creatorId: uuid('creator_id')
      .notNull()
      .references(() => creators.id, { onDelete: 'cascade' }),
    tagId: uuid('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.creatorId, t.tagId] }), index('creator_tags_tag_idx').on(t.tagId)],
)

export const collectionTags = pgTable(
  'collection_tags',
  {
    collectionId: uuid('collection_id')
      .notNull()
      .references(() => collections.id, { onDelete: 'cascade' }),
    tagId: uuid('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.collectionId, t.tagId] }),
    index('collection_tags_tag_idx').on(t.tagId),
  ],
)

/** External URLs. `host` is derived on write so the UI can badge by source. */
export const modelLinks = pgTable(
  'model_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    modelId: uuid('model_id').notNull(),
    url: text('url').notNull(),
    title: text('title'),
    host: text('host'),
    position: integer('position').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('model_links_model_url_uq').on(t.modelId, t.url)],
)

export const creatorLinks = pgTable(
  'creator_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    creatorId: uuid('creator_id')
      .notNull()
      .references(() => creators.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    title: text('title'),
    host: text('host'),
    position: integer('position').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('creator_links_creator_url_uq').on(t.creatorId, t.url)],
)
