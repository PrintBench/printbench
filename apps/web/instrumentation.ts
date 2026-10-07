/**
 * Runs once when the server starts.
 *
 * Its one job is to start copying console output into Postgres, so the web
 * process's log is readable under Diagnostics instead of only through
 * `docker logs`. The worker does the same in its own entry point.
 */
export async function register() {
  // Node only: the capture uses node:util and the database pool.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  // `next build` boots a server-like environment with no database behind it.
  if (process.env.NEXT_PHASE === 'phase-production-build') return

  const { installLogCapture } = await import('@pb/core')
  installLogCapture({ role: 'web', version: process.env.PB_VERSION })
}
