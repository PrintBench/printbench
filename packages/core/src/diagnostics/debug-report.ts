import { existsSync } from 'node:fs'
import { statfs } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { sql } from 'drizzle-orm'
import type { Database } from '@pb/db'
import { getSettings, type Settings } from '../settings/settings-service'
import { redactSecrets } from './redact'

/**
 * A snapshot of the instance, for attaching to a bug report.
 *
 * Written to be pasted into a public GitHub issue, which decides what is left
 * out: no hostnames, URLs, paths, email addresses, user names, model names or
 * library names — only shapes, counts, versions and states. The one exception
 * is the excerpt of recent warnings and errors, which is real log text with
 * secrets redacted; the UI lets it be left off and says to read it first.
 *
 * Each section is collected independently so one failing query costs that
 * section and not the report; a report that cannot be produced when something
 * is broken would be useless exactly when it is needed.
 */

export interface DebugProcess {
  source: string
  version: string | null
  node: string | null
  platform: string | null
  arch: string | null
  startedAt: string
  seenAt: string
  /** Heartbeat seen within the last two minutes. */
  alive: boolean
  rssMb: number | null
  heapUsedMb: number | null
}

export interface DebugLibrary {
  kind: string
  backend: string
  grouping: string
  scanEnabled: boolean
  scheduled: boolean
  watching: boolean
  allowWrites: boolean
  models: number
  missingModels: number
  files: number
  lastScan: {
    status: string
    mode: string
    finishedAt: string | null
    abortReason: string | null
  } | null
}

export interface DebugQueue {
  name: string
  queued: number
  active: number
  failed: number
}

export interface DebugReport {
  generatedAt: string
  app: { version: string; commit: string | null; nodeEnv: string }
  processes: DebugProcess[]
  host: {
    node: string
    platform: string
    arch: string
    osRelease: string
    cpus: number
    totalMemMb: number
    freeMemMb: number
    timezone: string
    inContainer: boolean
  }
  database: {
    version: string
    sizeBytes: number
    migrationsApplied: number
    lastMigrationAt: string | null
    extensions: string[]
    connections: number
  } | null
  config: Record<string, string>
  dataDir: { totalBytes: number; freeBytes: number } | null
  libraries: DebugLibrary[]
  counts: Record<string, number>
  users: Record<string, number>
  derived: { thumbnails: Record<string, number>; analysis: Record<string, number> }
  queues: DebugQueue[] | null
  problems: Record<string, number>
  settings: Omit<Settings, 'siteName'> | null
  recentErrors: {
    at: string
    level: string
    source: string
    scope: string | null
    message: string
  }[]
  /** Sections that could not be collected, and why. */
  failures: Record<string, string>
}

export interface DebugReportOptions {
  version: string
  commit?: string | null
  /** Collected by the caller: the queue lives in a package core does not depend on. */
  queues?: () => Promise<DebugQueue[]>
}

const ALIVE_WITHIN_MS = 2 * 60_000

function flag(name: string): string {
  const value = process.env[name]?.trim()
  return value ? value : '(unset)'
}

function isSet(name: string): string {
  return process.env[name]?.trim() ? 'set' : '(unset)'
}

function urlShape(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) return '(unset)'
  try {
    const url = new URL(value)
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    const subPath = url.pathname !== '/' && url.pathname !== ''
    return `${url.protocol}//${local ? 'localhost' : '<host>'}${url.port ? ':<port>' : ''}${subPath ? '/<path>' : ''}`
  } catch {
    return '(set, not a valid URL)'
  }
}

function countList(name: string, separator: string): string {
  const entries = (process.env[name] ?? '').split(separator).filter((entry) => entry.trim())
  return entries.length === 0
    ? '(unset)'
    : `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`
}

/** Configuration by shape only. Values that identify the deployment are reduced. */
function collectConfig(): Record<string, string> {
  return {
    NODE_ENV: flag('NODE_ENV'),
    APP_URL: urlShape('APP_URL'),
    BETTER_AUTH_URL: urlShape('BETTER_AUTH_URL'),
    BETTER_AUTH_TRUSTED_ORIGINS: countList('BETTER_AUTH_TRUSTED_ORIGINS', ','),
    BETTER_AUTH_SECRET: isSet('BETTER_AUTH_SECRET'),
    FILE_DELIVERY: flag('FILE_DELIVERY'),
    ACCEL_MOUNTS: countList('ACCEL_MOUNTS', ','),
    DATA_DIR: process.env.DATA_DIR
      ? path.isAbsolute(process.env.DATA_DIR)
        ? 'absolute path'
        : 'relative path'
      : '(unset)',
    LIBRARY_ROOTS: countList('LIBRARY_ROOTS', path.delimiter),
    DATABASE_POOL_MAX: flag('DATABASE_POOL_MAX'),
    RENDER_CONCURRENCY: flag('RENDER_CONCURRENCY'),
    WORKER_MEMORY_LOG: flag('WORKER_MEMORY_LOG'),
    LOG_LEVEL: flag('LOG_LEVEL'),
  }
}

function tally(rows: { key: string; n: number }[]): Record<string, number> {
  return Object.fromEntries(rows.map((row) => [row.key, Number(row.n)]))
}

export async function collectDebugReport(
  db: Database,
  options: DebugReportOptions,
): Promise<DebugReport> {
  const failures: Record<string, string> = {}

  async function section<T>(name: string, work: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await work()
    } catch (error) {
      failures[name] = redactSecrets(error instanceof Error ? error.message : String(error))
      return fallback
    }
  }

  const now = Date.now()

  const [
    processes,
    database,
    dataDir,
    libraries,
    counts,
    users,
    derived,
    queues,
    problems,
    settings,
    recentErrors,
  ] = await Promise.all([
    section<DebugProcess[]>(
      'processes',
      async () => {
        const result = await db.execute<{
          source: string
          started_at: Date
          seen_at: Date
          info: Record<string, unknown>
        }>(sql`SELECT source, started_at, seen_at, info FROM process_status ORDER BY source`)
        return result.rows.map((row) => ({
          source: row.source,
          version: typeof row.info.version === 'string' ? row.info.version : null,
          node: typeof row.info.node === 'string' ? row.info.node : null,
          platform: typeof row.info.platform === 'string' ? row.info.platform : null,
          arch: typeof row.info.arch === 'string' ? row.info.arch : null,
          startedAt: new Date(row.started_at).toISOString(),
          seenAt: new Date(row.seen_at).toISOString(),
          alive: now - new Date(row.seen_at).getTime() < ALIVE_WITHIN_MS,
          rssMb: typeof row.info.rssMb === 'number' ? row.info.rssMb : null,
          heapUsedMb: typeof row.info.heapUsedMb === 'number' ? row.info.heapUsedMb : null,
        }))
      },
      [],
    ),

    section<DebugReport['database']>(
      'database',
      async () => {
        const [version, migrations, extensions, connections] = await Promise.all([
          db.execute<{ version: string; size: number }>(
            sql`SELECT current_setting('server_version') AS version,
                         pg_database_size(current_database()) AS size`,
          ),
          db.execute<{ applied: number; latest: number | null }>(
            sql`SELECT count(*)::int AS applied, max(created_at) AS latest
                  FROM drizzle.__drizzle_migrations`,
          ),
          db.execute<{ name: string }>(
            sql`SELECT extname || ' ' || extversion AS name FROM pg_extension ORDER BY extname`,
          ),
          db.execute<{ n: number }>(
            sql`SELECT count(*)::int AS n FROM pg_stat_activity
                  WHERE datname = current_database()`,
          ),
        ])
        const latest = migrations.rows[0]?.latest
        return {
          version: version.rows[0]?.version ?? 'unknown',
          sizeBytes: Number(version.rows[0]?.size ?? 0),
          migrationsApplied: migrations.rows[0]?.applied ?? 0,
          lastMigrationAt: latest ? new Date(Number(latest)).toISOString() : null,
          extensions: extensions.rows.map((row) => row.name),
          connections: connections.rows[0]?.n ?? 0,
        }
      },
      null,
    ),

    section<DebugReport['dataDir']>(
      'dataDir',
      async () => {
        const configured = process.env.DATA_DIR?.trim()
        if (!configured || !path.isAbsolute(configured)) return null
        const stats = await statfs(configured)
        return { totalBytes: stats.blocks * stats.bsize, freeBytes: stats.bavail * stats.bsize }
      },
      null,
    ),

    section<DebugLibrary[]>(
      'libraries',
      async () => {
        const result = await db.execute<{
          kind: string
          backend: string
          grouping_mode: string
          scan_enabled: boolean
          scheduled: boolean
          watch_enabled: boolean
          allow_writes: boolean
          models: number
          missing_models: number
          files: number
          scan_status: string | null
          scan_mode: string | null
          scan_finished: Date | null
          scan_abort: string | null
        }>(sql`
            SELECT l.kind, l.backend, l.grouping_mode, l.scan_enabled,
                   (l.scan_cron IS NOT NULL) AS scheduled, l.watch_enabled, l.allow_writes,
                   (SELECT count(*)::int FROM models m WHERE m.library_id = l.id) AS models,
                   (SELECT count(*)::int FROM models m
                     WHERE m.library_id = l.id AND m.missing_at IS NOT NULL) AS missing_models,
                   (SELECT count(*)::int FROM model_files f
                     JOIN models m ON m.id = f.model_id WHERE m.library_id = l.id) AS files,
                   s.status AS scan_status, s.mode AS scan_mode,
                   s.finished_at AS scan_finished, s.abort_reason AS scan_abort
            FROM libraries l
            LEFT JOIN LATERAL (
              SELECT status, mode, finished_at, abort_reason FROM scan_runs r
              WHERE r.library_id = l.id ORDER BY r.created_at DESC LIMIT 1
            ) s ON true
            ORDER BY l.created_at`)
        return result.rows.map((row) => ({
          kind: row.kind,
          backend: row.backend,
          grouping: row.grouping_mode,
          scanEnabled: row.scan_enabled,
          scheduled: row.scheduled,
          watching: row.watch_enabled,
          allowWrites: row.allow_writes,
          models: row.models,
          missingModels: row.missing_models,
          files: row.files,
          lastScan: row.scan_status
            ? {
                status: row.scan_status,
                mode: row.scan_mode ?? 'fast',
                finishedAt: row.scan_finished ? new Date(row.scan_finished).toISOString() : null,
                abortReason: row.scan_abort,
              }
            : null,
        }))
      },
      [],
    ),

    section<Record<string, number>>(
      'counts',
      async () => {
        const result = await db.execute<Record<string, number>>(sql`
            SELECT (SELECT count(*) FROM models)::int AS models,
                   (SELECT count(*) FROM model_files)::int AS files,
                   (SELECT coalesce(sum(size), 0) FROM model_files)::bigint AS "fileBytes",
                   (SELECT count(*) FROM creators)::int AS creators,
                   (SELECT count(*) FROM tags)::int AS tags,
                   (SELECT count(*) FROM collections)::int AS collections,
                   (SELECT count(*) FROM print_runs)::int AS prints,
                   (SELECT count(*) FROM print_requests)::int AS "printRequests",
                   (SELECT count(*) FROM print_hosts)::int AS printers,
                   (SELECT count(*) FROM models WHERE share_token IS NOT NULL)::int AS "sharedModels",
                   (SELECT count(*) FROM audit_events)::int AS "auditEvents",
                   (SELECT count(*) FROM app_logs)::int AS "logLines"`)
        const row = result.rows[0] ?? {}
        return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value)]))
      },
      {},
    ),

    section<Record<string, number>>(
      'users',
      async () =>
        tally(
          (
            await db.execute<{ key: string; n: number }>(
              sql`SELECT CASE WHEN banned THEN 'suspended' ELSE role END AS key, count(*)::int AS n
                    FROM "user" GROUP BY 1`,
            )
          ).rows,
        ),
      {},
    ),

    section<DebugReport['derived']>(
      'derived',
      async () => {
        const [thumbs, analysis] = await Promise.all([
          db.execute<{ key: string; n: number }>(
            sql`SELECT thumb_state::text AS key, count(*)::int AS n FROM model_files GROUP BY 1`,
          ),
          db.execute<{ key: string; n: number }>(
            sql`SELECT analysis_state::text AS key, count(*)::int AS n FROM model_files GROUP BY 1`,
          ),
        ])
        return { thumbnails: tally(thumbs.rows), analysis: tally(analysis.rows) }
      },
      { thumbnails: {}, analysis: {} },
    ),

    section<DebugQueue[] | null>(
      'queues',
      async () => (options.queues ? await options.queues() : null),
      null,
    ),

    section<Record<string, number>>(
      'problems',
      async () =>
        tally(
          (
            await db.execute<{ key: string; n: number }>(
              sql`SELECT kind::text AS key, count(*)::int AS n FROM problems
                    WHERE resolved_at IS NULL AND ignored_at IS NULL GROUP BY 1`,
            )
          ).rows,
        ),
      {},
    ),

    section<DebugReport['settings']>(
      'settings',
      async () => {
        // The site name is the one setting that identifies the instance.
        const rest: Partial<Settings> = await getSettings(db)
        delete rest.siteName
        return rest as Omit<Settings, 'siteName'>
      },
      null,
    ),

    section<DebugReport['recentErrors']>(
      'recentErrors',
      async () => {
        const result = await db.execute<{
          at: Date
          level: string
          source: string
          scope: string | null
          message: string
        }>(sql`
            SELECT at, level, source, scope, message FROM app_logs
            WHERE level IN ('warn', 'error') ORDER BY id DESC LIMIT 25`)
        return result.rows.map((row) => ({
          at: new Date(row.at).toISOString(),
          level: row.level,
          source: row.source,
          scope: row.scope,
          // Already redacted on capture; again here in case the rules have improved since.
          message: redactSecrets(row.message).slice(0, 2000),
        }))
      },
      [],
    ),
  ])

  return {
    generatedAt: new Date(now).toISOString(),
    app: {
      version: options.version,
      commit: options.commit ?? null,
      nodeEnv: process.env.NODE_ENV ?? 'development',
    },
    processes,
    host: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      osRelease: os.release(),
      cpus: os.cpus().length,
      totalMemMb: Math.round(os.totalmem() / 1024 / 1024),
      freeMemMb: Math.round(os.freemem() / 1024 / 1024),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      inContainer: existsSync('/.dockerenv'),
    },
    database,
    config: collectConfig(),
    dataDir,
    libraries,
    counts,
    users,
    derived,
    queues,
    problems,
    settings,
    recentErrors,
    failures,
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`
}

function pairs(record: Record<string, string | number | boolean>): string {
  const entries = Object.entries(record)
  if (entries.length === 0) return '_none_'
  return entries.map(([key, value]) => `- **${key}:** ${String(value)}`).join('\n')
}

/** The report as GitHub-flavoured Markdown, ready to paste into an issue. */
export function debugReportToMarkdown(
  report: DebugReport,
  options: { includeLogs?: boolean } = {},
): string {
  const out: string[] = []
  const add = (...lines: string[]) => out.push(...lines)

  add(
    '### PrintBench debug report',
    '',
    `- **Version:** ${report.app.version}${report.app.commit ? ` (${report.app.commit.slice(0, 12)})` : ''}`,
    `- **Generated:** ${report.generatedAt}`,
    `- **Environment:** ${report.app.nodeEnv}${report.host.inContainer ? ', Docker' : ''}`,
    `- **Host:** ${report.host.platform}/${report.host.arch}, kernel ${report.host.osRelease}, ` +
      `${report.host.cpus} CPUs, ${report.host.totalMemMb} MB RAM (${report.host.freeMemMb} MB free), ` +
      `Node ${report.host.node}, TZ ${report.host.timezone}`,
    '',
  )

  add('#### Processes', '')
  if (report.processes.length === 0) add('_No heartbeats recorded._', '')
  else {
    add(
      '| Process | Version | Node | Up since | Last seen | Alive | RSS |',
      '|---|---|---|---|---|---|---|',
    )
    for (const p of report.processes) {
      add(
        `| ${p.source} | ${p.version ?? '?'} | ${p.node ?? '?'} | ${p.startedAt} | ${p.seenAt} | ` +
          `${p.alive ? 'yes' : '**no**'} | ${p.rssMb ?? '?'} MB |`,
      )
    }
    add('')
  }

  add('#### Database', '')
  if (report.database) {
    add(
      pairs({
        PostgreSQL: report.database.version,
        Size: formatBytes(report.database.sizeBytes),
        'Migrations applied': report.database.migrationsApplied,
        'Last migration': report.database.lastMigrationAt ?? 'unknown',
        Extensions: report.database.extensions.join(', ') || 'none',
        Connections: report.database.connections,
      }),
      '',
    )
  } else add('_Unavailable._', '')

  add('#### Configuration', '', pairs(report.config), '')
  if (report.dataDir) {
    add(
      `- **Data volume:** ${formatBytes(report.dataDir.freeBytes)} free of ${formatBytes(report.dataDir.totalBytes)}`,
      '',
    )
  }
  if (report.settings) add('#### Settings', '', pairs(report.settings), '')

  add('#### Libraries', '')
  if (report.libraries.length === 0) add('_None._', '')
  else {
    add(
      '| # | Kind | Backend | Grouping | Scan | Models | Missing | Files | Last scan |',
      '|---|---|---|---|---|---|---|---|---|',
    )
    report.libraries.forEach((library, index) => {
      const scan = [
        library.scanEnabled ? 'on' : 'off',
        library.scheduled ? 'scheduled' : null,
        library.watching ? 'watching' : null,
        library.allowWrites ? 'writable' : null,
      ]
        .filter(Boolean)
        .join(', ')
      const last = library.lastScan
        ? `${library.lastScan.status} (${library.lastScan.mode})` +
          (library.lastScan.abortReason ? `: ${library.lastScan.abortReason}` : '') +
          (library.lastScan.finishedAt ? ` at ${library.lastScan.finishedAt}` : '')
        : 'never'
      add(
        `| ${index + 1} | ${library.kind} | ${library.backend} | ${library.grouping} | ${scan} | ` +
          `${library.models} | ${library.missingModels} | ${library.files} | ${last} |`,
      )
    })
    add('')
  }

  const { fileBytes, ...otherCounts } = report.counts
  add(
    '#### Contents',
    '',
    pairs({ ...otherCounts, ...(fileBytes != null ? { fileSize: formatBytes(fileBytes) } : {}) }),
    '',
    `- **Users:** ${
      Object.entries(report.users)
        .map(([role, n]) => `${n} ${role}`)
        .join(', ') || 'none'
    }`,
    `- **Thumbnails:** ${
      Object.entries(report.derived.thumbnails)
        .map(([state, n]) => `${n} ${state}`)
        .join(', ') || 'none'
    }`,
    `- **Analysis:** ${
      Object.entries(report.derived.analysis)
        .map(([state, n]) => `${n} ${state}`)
        .join(', ') || 'none'
    }`,
    `- **Open health problems:** ${
      Object.entries(report.problems)
        .map(([kind, n]) => `${n} ${kind}`)
        .join(', ') || 'none'
    }`,
    '',
  )

  add('#### Job queues', '')
  if (!report.queues) add('_Unavailable._', '')
  else {
    add('| Queue | Queued | Active | Failed |', '|---|---|---|---|')
    for (const queue of report.queues) {
      add(`| ${queue.name} | ${queue.queued} | ${queue.active} | ${queue.failed} |`)
    }
    add('')
  }

  if (Object.keys(report.failures).length > 0) {
    add('#### Sections that could not be collected', '', pairs(report.failures), '')
  }

  if (options.includeLogs === false) return out.join('\n')

  add(
    '<details>',
    `<summary>Recent warnings and errors (${report.recentErrors.length})</summary>`,
    '',
    '```text',
    ...(report.recentErrors.length === 0
      ? ['(none)']
      : report.recentErrors
          .slice()
          .reverse()
          .map(
            (entry) =>
              `${entry.at} ${entry.level.toUpperCase().padEnd(5)} ${entry.source.padEnd(6)} ` +
              `${entry.scope ? `[${entry.scope}] ` : ''}${entry.message.replace(/```/g, "'''")}`,
          )),
    '```',
    '',
    '</details>',
    '',
  )

  return out.join('\n')
}
