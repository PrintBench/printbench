import { customType } from 'drizzle-orm/pg-core'

/**
 * Postgres `tsvector`. Drizzle has no native mapping, and we never read the
 * value in application code — it exists purely for the GIN index to search.
 * Maintained by packages/core/search/refresh.ts, not by a generated column
 * (generated columns can only reference their own row, and we need tags,
 * creator name and filenames in the vector).
 */
export const tsvector = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'tsvector'
  },
})

/**
 * Millisecond epoch as bigint. Postgres bigint exceeds JS safe-integer range in
 * theory, but mtimes and file sizes never will, so `mode: 'number'` is safe and
 * spares every call site a BigInt conversion.
 */
export const epochMs = () => ({ mode: 'number' }) as const
