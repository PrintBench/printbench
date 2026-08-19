import { index, integer, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { listKind } from './enums'
import { user } from './auth'

/**
 * User-owned lists. Each user has exactly one `liked` list, enforced by a
 * partial unique index added in migration.
 */
export const lists = pgTable(
  'lists',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    kind: listKind('kind').notNull().default('normal'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('lists_user_idx').on(t.userId)],
)

export const listItems = pgTable(
  'list_items',
  {
    listId: uuid('list_id')
      .notNull()
      .references(() => lists.id, { onDelete: 'cascade' }),
    modelId: uuid('model_id').notNull(),
    position: integer('position').notNull().default(0),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.listId, t.modelId] }), index('list_items_model_idx').on(t.modelId)],
)
