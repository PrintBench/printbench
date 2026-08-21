#!/bin/sh
set -eu

# Migrations run once, from the web container only. The worker waits for the
# schema rather than racing to apply it — two processes running migrate
# concurrently is a classic self-hosting failure.
case "${1:-web}" in
  web)
    echo "[entrypoint] applying database migrations"
    node --import tsx packages/db/src/migrate.ts
    echo "[entrypoint] starting web"
    exec node apps/web/server.js
    ;;
  worker)
    echo "[entrypoint] waiting for schema"
    until node --import tsx -e "
      import('@pb/db').then(async ({ createDb }) => {
        const { pool, db } = createDb()
        const { sql } = await import('drizzle-orm')
        await db.execute(sql\`select 1 from models limit 1\`)
        await pool.end()
      }).catch(() => process.exit(1))
    " 2>/dev/null; do
      echo "[entrypoint] schema not ready, retrying in 3s"
      sleep 3
    done
    echo "[entrypoint] starting worker"
    exec node --import tsx apps/worker/src/index.ts
    ;;
  *)
    exec "$@"
    ;;
esac
