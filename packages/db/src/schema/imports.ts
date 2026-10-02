import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { user } from './auth'
import { libraries } from './libraries'
import { models } from './models'

/** Per-user credentials. Only the worker uses the decrypted token for provider requests. */
export const providerCredentials = pgTable('provider_credentials', {
  userId: text('user_id')
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  makerWorldCookieEncrypted: text('makerworld_cookie_encrypted').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/** An import stays inspectable after its queue delivery has been retired. */
export const modelImports = pgTable(
  'model_imports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    libraryId: uuid('library_id')
      .notNull()
      .references(() => libraries.id, { onDelete: 'cascade' }),
    sourceUrl: text('source_url').notNull(),
    state: text('state', { enum: ['queued', 'importing', 'complete', 'failed'] })
      .notNull()
      .default('queued'),
    modelId: uuid('model_id').references(() => models.id, { onDelete: 'set null' }),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('model_imports_library_source_uq').on(t.libraryId, t.sourceUrl),
    index('model_imports_user_idx').on(t.userId, t.createdAt),
  ],
)
