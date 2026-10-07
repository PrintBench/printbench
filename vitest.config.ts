import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Load .env so `npm test` works without callers exporting DATABASE_URL by hand.
if (existsSync('.env')) process.loadEnvFile('.env')

export default defineConfig({
  // The web app's `@/` import alias, so its server actions load under test.
  resolve: { alias: { '@': fileURLToPath(new URL('./apps/web', import.meta.url)) } },
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'reference/**'],
    // Integration tests share one Postgres; parallel files would clobber
    // each other's fixtures.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
