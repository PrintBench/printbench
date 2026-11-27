import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { VITEST_INCLUDE } from './scripts/test-map/runners.js'

export default defineConfig(({ mode }) => {
  const unitOnly = mode === 'unit'
  // Unit runs do not need local database configuration. Full and integration
  // runs load it just like the migration command does.
  if (!unitOnly && existsSync('.env')) process.loadEnvFile('.env')
  if (!unitOnly && !process.env.DATABASE_URL?.trim()) {
    throw new Error(
      'DATABASE_URL is required for full and integration test runs. ' +
        'Copy .env.example to .env, then run npm run db:up and npm run db:migrate. ' +
        'For tests without Postgres, use npm run test:unit.',
    )
  }

  return {
    // The web app's `@/` import alias, so its server actions load under test.
    resolve: { alias: { '@': fileURLToPath(new URL('./apps/web', import.meta.url)) } },
    test: {
      include: VITEST_INCLUDE,
      // `next build` copies test files into .next/standalone, and those stale
      // duplicates would otherwise run alongside the real ones.
      exclude: ['**/node_modules/**', '**/.next/**', 'reference/**'],
      tags: [{ name: 'integration' }],
      tagsFilter: unitOnly
        ? ['!integration']
        : mode === 'integration'
          ? ['integration']
          : undefined,
      // Integration tests share one Postgres; parallel files would clobber
      // each other's fixtures.
      fileParallelism: false,
      testTimeout: 30_000,
      hookTimeout: 30_000,
    },
  }
})
