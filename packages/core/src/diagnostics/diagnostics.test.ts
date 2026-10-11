import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { createDb } from '@pb/db'
import {
  auditCategory,
  auditEventsToCsv,
  auditLabel,
  listAuditEvents,
  pruneAuditEvents,
  recordAudit,
} from './audit-service'
import { collectDebugReport, debugReportToMarkdown } from './debug-report'
import { parseLogLine } from './log-capture'
import { formatLogLines, listLogs, pruneLogs } from './log-service'
import { redactSecrets } from './redact'

describe('redactSecrets', () => {
  it('removes the password from a connection string', () => {
    const out = redactSecrets('connect ECONNREFUSED postgres://printbench:hunter2secret@db:5432/pb')
    expect(out).not.toContain('hunter2secret')
    expect(out).toContain('postgres://printbench:[redacted]@db:5432/pb')
  })

  it('removes keyed values and bearer tokens but leaves ordinary text', () => {
    expect(redactSecrets('password=abc12345 next')).toBe('password=[redacted] next')
    expect(redactSecrets('{"apiKey":"sk_live_1234"}')).not.toContain('sk_live_1234')
    expect(redactSecrets('Authorization: Bearer abcdefgh12345678')).not.toContain(
      'abcdefgh12345678',
    )
    expect(redactSecrets('[scan] finished "Minis" in 2.1s')).toBe('[scan] finished "Minis" in 2.1s')
  })

  it('removes secrets this process was configured with', () => {
    const previous = process.env.BETTER_AUTH_SECRET
    process.env.BETTER_AUTH_SECRET = 'a-signing-secret-value'
    try {
      expect(redactSecrets('boom a-signing-secret-value boom')).toBe('boom [redacted] boom')
    } finally {
      if (previous === undefined) delete process.env.BETTER_AUTH_SECRET
      else process.env.BETTER_AUTH_SECRET = previous
    }
  })
})

describe('parseLogLine', () => {
  it('lifts the scope prefix the codebase writes', () => {
    expect(parseLogLine('[scan] starting fast scan of "Minis"')).toEqual({
      scope: 'scan',
      message: 'starting fast scan of "Minis"',
    })
  })

  it('leaves an unscoped line alone and strips terminal colours', () => {
    expect(parseLogLine('\u001b[31mplain failure\u001b[0m')).toEqual({
      scope: null,
      message: 'plain failure',
    })
  })

  it('redacts before anything is stored', () => {
    expect(parseLogLine('[db] postgres://u:topsecretpw@h/db').message).not.toContain('topsecretpw')
  })
})

describe('audit labels', () => {
  it('derives the category from the action', () => {
    expect(auditCategory('model.updated')).toBe('model')
    expect(auditCategory('nonsense.thing')).toBeNull()
    expect(auditLabel('auth.login_failed')).toBe('Failed sign-in')
    expect(auditLabel('unknown.action')).toBe('unknown.action')
  })
})

const url = process.env.DATABASE_URL

/** Marks this file's rows so it never touches a real trail in the dev database. */
const MARK = 'diagnostics-test'

describe('diagnostics storage', { tags: ['integration'] }, () => {
  let pool: ReturnType<typeof createDb>['pool']
  let db: ReturnType<typeof createDb>['db']

  const clean = async () => {
    await db.execute(sql`DELETE FROM audit_events WHERE ip = ${MARK}`)
    await db.execute(sql`DELETE FROM app_logs WHERE scope = ${MARK}`)
  }

  beforeAll(() => {
    ;({ pool, db } = createDb(url))
  })
  beforeEach(clean)
  afterAll(async () => {
    await clean()
    await pool.end()
  })

  it('records an event and finds it by category, outcome and text', async () => {
    await recordAudit(db, {
      action: 'model.updated',
      actor: { type: 'user', id: 'u1', name: 'Ada Lovelace' },
      target: { type: 'model', id: 'abc', label: 'Benchy' },
      detail: { changed: 'name, tags', skipped: undefined },
      ip: MARK,
    })
    await recordAudit(db, {
      action: 'auth.login_failed',
      outcome: 'failure',
      actor: { type: 'anonymous', name: 'mallory@example.com' },
      ip: MARK,
    })

    const models = await listAuditEvents(db, { category: 'model', query: MARK })
    expect(models.total).toBe(1)
    expect(models.events[0]).toMatchObject({
      action: 'model.updated',
      actorType: 'user',
      actorId: 'u1',
      actorName: 'Ada Lovelace',
      targetLabel: 'Benchy',
      outcome: 'success',
      source: 'web',
      detail: { changed: 'name, tags' },
    })

    const failures = await listAuditEvents(db, { outcome: 'failure', query: MARK })
    expect(failures.events.map((event) => event.action)).toEqual(['auth.login_failed'])
    expect(failures.events[0]!.actorId).toBeNull()

    expect((await listAuditEvents(db, { query: 'lovelace' })).events.length).toBeGreaterThan(0)
  })

  it('never throws, even when the write cannot succeed', async () => {
    const broken = {
      insert: () => {
        throw new Error('database is down')
      },
    } as unknown as typeof db
    await expect(
      recordAudit(broken, { action: 'auth.login', actor: { type: 'system' } }),
    ).resolves.toBeUndefined()
  })

  it('prunes by age and keeps everything when retention is zero', async () => {
    await recordAudit(db, { action: 'auth.login', actor: { type: 'system' }, ip: MARK })
    await db.execute(
      sql`UPDATE audit_events SET occurred_at = now() - interval '400 days' WHERE ip = ${MARK}`,
    )
    expect(await pruneAuditEvents(db, 0)).toBe(0)
    expect((await listAuditEvents(db, { query: MARK })).total).toBe(1)
    expect(await pruneAuditEvents(db, 365)).toBeGreaterThanOrEqual(1)
    expect((await listAuditEvents(db, { query: MARK })).total).toBe(0)
  })

  it('exports CSV that a spreadsheet will not execute', async () => {
    await recordAudit(db, {
      action: 'tag.updated',
      actor: { type: 'user', id: 'u1', name: '=HYPERLINK("http://evil")' },
      target: { type: 'tag', label: 'a, "quoted" tag' },
      ip: MARK,
    })
    const { events } = await listAuditEvents(db, { query: MARK })
    const csv = auditEventsToCsv(events)
    expect(csv.split('\n')[0]).toContain('time,action,outcome,actor')
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"")"`)
    expect(csv).toContain('"a, ""quoted"" tag"')
  })

  it('lists logs by level, source and text, newest first', async () => {
    await db.execute(sql`
      INSERT INTO app_logs (level, source, scope, message) VALUES
        ('info',  'worker', ${MARK}, 'first line'),
        ('warn',  'worker', ${MARK}, 'second line'),
        ('error', 'web',    ${MARK}, 'third line')`)

    const all = await listLogs(db, { query: MARK })
    expect(all.map((entry) => entry.message)).toEqual(['third line', 'second line', 'first line'])

    const warnings = await listLogs(db, { query: MARK, minLevel: 'warn' })
    expect(warnings.map((entry) => entry.level)).toEqual(['error', 'warn'])

    const worker = await listLogs(db, { query: MARK, source: 'worker' })
    expect(worker).toHaveLength(2)

    const older = await listLogs(db, { query: MARK, beforeId: all[0]!.id })
    expect(older.map((entry) => entry.message)).toEqual(['second line', 'first line'])

    const text = formatLogLines(all)
    expect(text.split('\n')).toHaveLength(3)
    expect(text.split('\n')[0]).toMatch(/INFO {2}worker \[diagnostics-test\] first line$/)
  })

  it('prunes logs older than the retention window', async () => {
    await db.execute(sql`
      INSERT INTO app_logs (at, level, source, scope, message) VALUES
        (now() - interval '30 days', 'info', 'web', ${MARK}, 'old'),
        (now(), 'info', 'web', ${MARK}, 'new')`)
    await pruneLogs(db, 14)
    expect((await listLogs(db, { query: MARK })).map((entry) => entry.message)).toEqual(['new'])
  })

  it('builds a debug report that names nothing identifying', async () => {
    await db.execute(sql`
      INSERT INTO app_logs (level, source, scope, message)
      VALUES ('error', 'worker', ${MARK}, 'render failed for a file')`)

    const report = await collectDebugReport(db, {
      version: '9.9.9',
      queues: async () => [{ name: 'library.scan', queued: 1, active: 0, failed: 2 }],
    })

    expect(report.failures).toEqual({})
    expect(report.app.version).toBe('9.9.9')
    expect(report.database?.version).toMatch(/^\d+/)
    expect(report.database?.migrationsApplied).toBeGreaterThan(0)
    expect(report.settings).not.toHaveProperty('siteName')
    expect(report.recentErrors.some((entry) => entry.message.includes('render failed'))).toBe(true)

    const markdown = debugReportToMarkdown(report)
    expect(markdown).toContain('### PrintBench debug report')
    expect(markdown).toContain('| library.scan | 1 | 0 | 2 |')
    expect(markdown).toContain('render failed for a file')
    expect(debugReportToMarkdown(report, { includeLogs: false })).not.toContain('render failed')

    // The configuration section describes shapes, never the values themselves.
    const databaseUrl = new URL(url!)
    expect(JSON.stringify(report.config)).not.toContain(
      databaseUrl.hostname + ':' + databaseUrl.port,
    )
    if (databaseUrl.password) expect(JSON.stringify(report)).not.toContain(databaseUrl.password)
  })

  it('reports a section that fails instead of failing the report', async () => {
    const report = await collectDebugReport(db, {
      version: '9.9.9',
      queues: async () => {
        throw new Error('queue unreachable at postgres://u:supersecret@h/db')
      },
    })
    expect(report.queues).toBeNull()
    expect(report.failures.queues).toContain('queue unreachable')
    expect(report.failures.queues).not.toContain('supersecret')
    expect(report.database).not.toBeNull()
  })
})
