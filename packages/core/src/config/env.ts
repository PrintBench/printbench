import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

/**
 * Loads the repo-root .env into process.env for local development.
 *
 * Both apps live in subdirectories and Node/Next only look for .env relative to
 * their own working directory, so without this `npm run dev` starts with no
 * DATABASE_URL.
 *
 * Deliberately a no-op in production: Docker and Coolify inject real
 * environment variables, and the filesystem probe would otherwise make
 * Turbopack trace the entire project into the standalone bundle.
 */
export function loadRootEnv(): void {
  if (process.env.NODE_ENV === 'production') return

  const here = path.dirname(fileURLToPath(import.meta.url))
  const candidates = [
    path.resolve(here, '../../../../.env'),
    path.resolve(process.cwd(), '.env'),
    path.resolve(process.cwd(), '../../.env'),
  ]
  for (const file of candidates) {
    // turbopackIgnore: paths are dynamic by design and this never runs in prod.
    if (existsSync(/* turbopackIgnore: true */ file)) {
      process.loadEnvFile(file)
      return
    }
  }
}
