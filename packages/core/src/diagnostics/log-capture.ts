import { formatWithOptions } from 'node:util'
import { sql } from 'drizzle-orm'
import { getDb, schema } from '@pb/db'
import { setProcessRole, type ProcessRole } from './process-role'
import { redactSecrets } from './redact'

/**
 * Copies console output into Postgres so it can be read from the web UI.
 *
 * The app already logs through `console` everywhere, and that output is only
 * reachable with `docker logs`. Rather than change seventy call sites, the
 * console methods are wrapped: every line still goes to stdout exactly as
 * before, and a copy is buffered and written in batches.
 *
 * The capture must never become the problem it is there to diagnose, so:
 * nothing here logs through console (that would recurse), a database that is
 * down costs a bounded buffer and nothing else, and the timers are unref'd so
 * they never hold a process open.
 */

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const
export type LogLevel = (typeof LOG_LEVELS)[number]

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value)
}

interface Entry {
  at: Date
  level: LogLevel
  source: ProcessRole
  scope: string | null
  message: string
}

const FLUSH_MS = 2_000
const HEARTBEAT_MS = 30_000
const BATCH = 200
/** Lines held while the database is unreachable. Oldest are dropped first. */
const BUFFER_MAX = 2_000
const MESSAGE_MAX = 8_000

const INSTALLED = Symbol.for('printbench.log-capture')
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g
const SCOPE = /^\[([a-z0-9][a-z0-9:._-]{0,31})\]\s*/i

const CONSOLE_METHODS = {
  debug: 'debug',
  log: 'info',
  info: 'info',
  warn: 'warn',
  error: 'error',
} as const satisfies Record<string, LogLevel>

export interface LogCaptureOptions {
  role: ProcessRole
  /** App version, reported on the heartbeat. */
  version?: string
}

export interface LogCapture {
  /** Writes whatever is buffered. Call before closing the pool on shutdown. */
  flush: () => Promise<void>
}

/** Splits a formatted console line into its `[scope]` prefix and the rest. */
export function parseLogLine(text: string): { scope: string | null; message: string } {
  const clean = text.replace(ANSI, '')
  const match = SCOPE.exec(clean)
  const body = match ? clean.slice(match[0].length) : clean
  const message = redactSecrets(body)
  return {
    scope: match ? match[1]!.toLowerCase() : null,
    message:
      message.length > MESSAGE_MAX ? `${message.slice(0, MESSAGE_MAX)}… [truncated]` : message,
  }
}

function minimumLevel(): LogLevel {
  const configured = process.env.LOG_LEVEL?.trim().toLowerCase()
  return isLogLevel(configured) ? configured : 'info'
}

export function installLogCapture(options: LogCaptureOptions): LogCapture {
  setProcessRole(options.role)

  const globals = globalThis as { [INSTALLED]?: LogCapture }
  // Next's dev server re-runs registration on reload; wrap the console once.
  if (globals[INSTALLED]) return globals[INSTALLED]

  const threshold = LOG_LEVELS.indexOf(minimumLevel())
  const startedAt = new Date()
  const buffer: Entry[] = []
  let flushing: Promise<void> | undefined
  let lastComplaint = 0

  const push = (level: LogLevel, args: unknown[]) => {
    if (LOG_LEVELS.indexOf(level) < threshold) return
    try {
      const text = formatWithOptions({ colors: false, depth: 4, breakLength: 120 }, ...args)
      if (text.trim() === '') return
      buffer.push({ at: new Date(), level, source: options.role, ...parseLogLine(text) })
      if (buffer.length > BUFFER_MAX) buffer.splice(0, buffer.length - BUFFER_MAX)
    } catch {
      // A value that cannot be formatted is not worth losing the process over.
    }
  }

  for (const [method, level] of Object.entries(CONSOLE_METHODS)) {
    const key = method as keyof typeof CONSOLE_METHODS
    const original = console[key].bind(console)
    console[key] = (...args: unknown[]) => {
      original(...args)
      push(level, args)
    }
  }

  // Node prints a fatal error straight to stderr, bypassing console entirely.
  process.on('uncaughtExceptionMonitor', (error, origin) => {
    push('error', [`[fatal] ${origin}:`, error])
  })

  const complain = (what: string, error: unknown) => {
    const now = Date.now()
    if (now - lastComplaint < 60_000) return
    lastComplaint = now
    const reason = error instanceof Error ? error.message : String(error)
    process.stderr.write(`[log-capture] ${what}: ${redactSecrets(reason)}\n`)
  }

  const writeBuffered = async () => {
    while (buffer.length > 0) {
      const batch = buffer.splice(0, BATCH)
      try {
        await getDb().insert(schema.appLogs).values(batch)
      } catch (error) {
        // Put them back and try again on the next tick.
        buffer.unshift(...batch)
        if (buffer.length > BUFFER_MAX) buffer.splice(0, buffer.length - BUFFER_MAX)
        complain('could not store log lines', error)
        return
      }
    }
  }

  const flush = (): Promise<void> => {
    flushing ??= writeBuffered().finally(() => {
      flushing = undefined
    })
    return flushing
  }

  const heartbeat = async () => {
    const memory = process.memoryUsage()
    const info = {
      version: options.version ?? null,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      pid: process.pid,
      rssMb: Math.round(memory.rss / 1024 / 1024),
      heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
    }
    try {
      await getDb().execute(sql`
        INSERT INTO process_status (source, started_at, seen_at, info)
        VALUES (${options.role}, ${startedAt.toISOString()}::timestamptz, now(), ${JSON.stringify(info)}::jsonb)
        ON CONFLICT (source) DO UPDATE
          SET started_at = excluded.started_at, seen_at = now(), info = excluded.info`)
    } catch (error) {
      complain('could not record heartbeat', error)
    }
  }

  setInterval(() => void flush(), FLUSH_MS).unref()
  setInterval(() => void heartbeat(), HEARTBEAT_MS).unref()
  void heartbeat()

  const capture: LogCapture = { flush }
  globals[INSTALLED] = capture
  return capture
}
