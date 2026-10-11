import { defineConfig } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

if (!process.env.DATABASE_URL?.trim()) {
  throw new Error('Smoke tests require DATABASE_URL pointing at an empty, migrated test database.')
}

// Check before starting the worker, whose schedules must never run against an
// existing instance. Child test processes inherit this marker.
if (process.env.SMOKE_DB_CHECKED !== '1') {
  execFileSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'scripts/smoke/preflight.mts'], {
    stdio: 'inherit',
  })
  process.env.SMOKE_DB_CHECKED = '1'
}

// Inherited by Playwright's worker and both app processes, which must see the
// same files. No development .env is loaded by this configuration.
const root = process.env.SMOKE_ROOT ?? mkdtempSync(path.join(tmpdir(), 'pb-smoke-'))
process.env.SMOKE_ROOT = root
const env = {
  ...process.env,
  DATA_DIR: path.join(root, 'data'),
  LIBRARY_ROOTS: root,
  MANAGED_LIBRARY_ROOT: path.join(root, 'libraries'),
  BETTER_AUTH_SECRET: 'smoke-only-secret-at-least-32-characters',
  BETTER_AUTH_URL: 'http://localhost:3000',
  APP_URL: 'http://localhost:3000',
  WORKER_URL: 'http://localhost:3001',
  WORKER_PORT: '3001',
  FILE_DELIVERY: 'node',
  NEXT_TELEMETRY_DISABLED: '1',
}

export default defineConfig({
  testDir: './scripts/smoke',
  testMatch: '**/*.spec.ts',
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  outputDir: 'test-results',
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:3000',
    browserName: 'chromium',
    screenshot: 'only-on-failure',
  },
  globalTeardown: './scripts/smoke/teardown.ts',
  webServer: [
    {
      command:
        'node node_modules/next/dist/bin/next start apps/web --port 3000 --hostname 127.0.0.1',
      url: 'http://localhost:3000/api/health',
      env,
      reuseExistingServer: false,
      timeout: 60_000,
      gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
    },
    {
      command: 'npm run start -w @pb/worker',
      url: 'http://localhost:3001/health',
      env,
      reuseExistingServer: false,
      timeout: 60_000,
      gracefulShutdown: { signal: 'SIGTERM', timeout: 45_000 },
    },
  ],
})
