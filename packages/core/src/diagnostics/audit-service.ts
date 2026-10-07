import { and, count, desc, eq, gte, ilike, like, lte, or, sql, type SQL } from 'drizzle-orm'
import { schema, type Database } from '@pb/db'
import { processRole } from './process-role'

/**
 * The audit trail: who did what, and when.
 *
 * Every action is declared here, so the trail reads consistently and the UI
 * can label and group events without guessing. The part before the dot is the
 * category the trail filters by.
 */
export const AUDIT_ACTIONS = {
  'auth.login': 'Signed in',
  'auth.login_failed': 'Failed sign-in',
  'auth.logout': 'Signed out',
  'auth.password_changed': 'Changed their password',
  'auth.password_reset': 'Reset a password with a recovery link',
  'auth.password_reset_issued': 'Issued a password reset link',
  'auth.setup': 'Created the first admin account',

  'user.created': 'Added a user',
  'user.updated': 'Edited a user',
  'user.role_changed': 'Changed a role',
  'user.suspended': 'Suspended a user',
  'user.restored': 'Restored a suspended user',
  'user.deleted': 'Deleted a user',
  'user.invited': 'Sent an invitation',
  'user.invite_cancelled': 'Cancelled an invitation',
  'user.invite_accepted': 'Accepted an invitation',

  'model.created': 'Added a model',
  'model.updated': 'Edited a model',
  'model.deleted': 'Removed a model from the library',
  'model.files_deleted': 'Deleted a model and its files',
  'model.restored': 'Restored a removed model',
  'model.moved': 'Moved a model',
  'model.imported': 'Started a model import',
  'model.shared': 'Created a share link',
  'model.unshared': 'Revoked a share link',
  'model.sent_to_printer': 'Sent a file to a printer',

  'library.created': 'Added a library',
  'library.updated': 'Changed a library',
  'library.deleted': 'Deleted a library',
  'library.scan_requested': 'Requested a scan',
  'library.scan_completed': 'Scan finished',
  'library.scan_aborted': 'Scan aborted',
  'library.scan_failed': 'Scan failed',

  'creator.created': 'Added a creator',

  'tag.updated': 'Changed a tag',
  'tag.merged': 'Merged tags',
  'tag.deleted': 'Deleted a tag',

  'collection.created': 'Created a collection',
  'collection.updated': 'Renamed a collection',
  'collection.deleted': 'Deleted a collection',

  'print.logged': 'Logged a print',
  'print.completed': 'Print completed',
  'print.updated': 'Edited a print',
  'print.deleted': 'Deleted a print',

  'request.created': 'Added to the print queue',
  'request.updated': 'Edited a print request',
  'request.status_changed': 'Moved a print request',
  'request.completed': 'Print request completed',
  'request.deleted': 'Removed a print request',

  'printer.created': 'Added a printer',
  'printer.updated': 'Changed a printer',
  'printer.deleted': 'Removed a printer',

  'settings.updated': 'Changed settings',
  'settings.reset': 'Reset a setting',

  'integration.connected': 'Saved import credentials',

  'health.rechecked': 'Re-examined library health',
  'health.problems_updated': 'Triaged health problems',

  'maintenance.pruned': 'Removed long-missing models',
  'diagnostics.exported': 'Exported diagnostics',
} as const

export type AuditAction = keyof typeof AUDIT_ACTIONS

export const AUDIT_CATEGORIES = {
  auth: 'Sign-ins',
  user: 'Users',
  model: 'Models',
  library: 'Libraries',
  creator: 'Creators',
  tag: 'Tags',
  collection: 'Collections',
  print: 'Prints',
  request: 'Print queue',
  printer: 'Printers',
  settings: 'Settings',
  integration: 'Integrations',
  health: 'Health',
  maintenance: 'Maintenance',
  diagnostics: 'Diagnostics',
} as const

export type AuditCategory = keyof typeof AUDIT_CATEGORIES

export function auditCategory(action: string): AuditCategory | null {
  const prefix = action.split('.')[0] ?? ''
  return prefix in AUDIT_CATEGORIES ? (prefix as AuditCategory) : null
}

export function auditLabel(action: string): string {
  return action in AUDIT_ACTIONS ? AUDIT_ACTIONS[action as AuditAction] : action
}

export type AuditActor =
  | { type: 'user'; id: string; name?: string | null }
  | { type: 'system'; name?: string }
  | { type: 'anonymous'; name?: string | null }

export const SYSTEM_ACTOR: AuditActor = { type: 'system' }

export interface AuditEventInput {
  action: AuditAction
  actor: AuditActor
  target?: { type: string; id?: string | null; label?: string | null }
  /** Small, JSON-safe context. Never put a password, token or cookie here. */
  detail?: Record<string, unknown>
  outcome?: 'success' | 'failure'
  ip?: string | null
}

const LABEL_MAX = 300
const DETAIL_MAX = 4000

/**
 * Appends one event to the trail.
 *
 * Never throws and never rejects: the audit trail describes what happened, and
 * a failure to write it must not turn a save that worked into an error on
 * screen. A write that fails is logged instead.
 */
export async function recordAudit(db: Database, event: AuditEventInput): Promise<void> {
  try {
    await db.insert(schema.auditEvents).values({
      action: event.action,
      outcome: event.outcome ?? 'success',
      actorType: event.actor.type,
      actorId: event.actor.type === 'user' ? event.actor.id : null,
      actorName: clip(event.actor.name),
      targetType: event.target?.type ?? null,
      targetId: event.target?.id ?? null,
      targetLabel: clip(event.target?.label),
      detail: safeDetail(event.detail),
      ip: clip(event.ip, 64),
      source: processRole(),
    })
  } catch (error) {
    console.error(`[audit] could not record ${event.action}:`, error)
  }
}

function clip(value: string | null | undefined, max = LABEL_MAX): string | null {
  if (value == null || value === '') return null
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

function safeDetail(detail: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!detail) return null
  const entries = Object.entries(detail).filter(([, value]) => value !== undefined)
  if (entries.length === 0) return null
  try {
    const json = JSON.stringify(Object.fromEntries(entries))
    if (json.length > DETAIL_MAX) return { truncated: true, preview: json.slice(0, DETAIL_MAX) }
    return JSON.parse(json) as Record<string, unknown>
  } catch {
    return { unserialisable: true }
  }
}

export interface AuditFilter {
  category?: AuditCategory
  outcome?: 'success' | 'failure'
  /** Matches actor, target, action and IP. */
  query?: string
  from?: Date
  to?: Date
  limit?: number
  offset?: number
}

export type AuditEvent = typeof schema.auditEvents.$inferSelect

function auditWhere(filter: AuditFilter): SQL | undefined {
  const t = schema.auditEvents
  const conditions: (SQL | undefined)[] = []
  if (filter.category) conditions.push(like(t.action, `${filter.category}.%`))
  if (filter.outcome) conditions.push(eq(t.outcome, filter.outcome))
  if (filter.from) conditions.push(gte(t.occurredAt, filter.from))
  if (filter.to) conditions.push(lte(t.occurredAt, filter.to))
  const query = filter.query?.trim()
  if (query) {
    const pattern = `%${query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`
    conditions.push(
      or(
        ilike(t.actorName, pattern),
        ilike(t.targetLabel, pattern),
        ilike(t.action, pattern),
        ilike(t.ip, pattern),
      ),
    )
  }
  return and(...conditions)
}

export async function listAuditEvents(
  db: Database,
  filter: AuditFilter = {},
): Promise<{ events: AuditEvent[]; total: number }> {
  const where = auditWhere(filter)
  const [events, totals] = await Promise.all([
    db
      .select()
      .from(schema.auditEvents)
      .where(where)
      .orderBy(desc(schema.auditEvents.occurredAt), desc(schema.auditEvents.id))
      .limit(Math.min(filter.limit ?? 50, 5000))
      .offset(filter.offset ?? 0),
    db.select({ total: count() }).from(schema.auditEvents).where(where),
  ])
  return { events, total: totals[0]?.total ?? 0 }
}

/** Drops events older than the retention window. Zero keeps everything. */
export async function pruneAuditEvents(db: Database, retentionDays: number): Promise<number> {
  if (retentionDays <= 0) return 0
  const result = await db.execute(sql`
    DELETE FROM audit_events
    WHERE occurred_at < now() - make_interval(days => ${retentionDays})`)
  return result.rowCount ?? 0
}

function csvCell(value: unknown): string {
  if (value == null) return ''
  let text = typeof value === 'string' ? value : JSON.stringify(value)
  // A cell a spreadsheet would execute is neutralised, not trusted.
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function auditEventsToCsv(events: AuditEvent[]): string {
  const header = [
    'time',
    'action',
    'outcome',
    'actor',
    'actor_type',
    'target_type',
    'target',
    'ip',
    'source',
    'detail',
  ]
  const lines = events.map((event) =>
    [
      event.occurredAt.toISOString(),
      event.action,
      event.outcome,
      event.actorName,
      event.actorType,
      event.targetType,
      event.targetLabel ?? event.targetId,
      event.ip,
      event.source,
      event.detail,
    ]
      .map(csvCell)
      .join(','),
  )
  return [header.join(','), ...lines].join('\n') + '\n'
}
