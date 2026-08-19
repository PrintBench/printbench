import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './src/schema/index.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
  // Generated SQL is always hand-reviewed before committing: drizzle-kit cannot
  // emit extensions, tsvector maintenance, partial or GIN/trgm indexes.
  verbose: true,
  strict: true,
})
