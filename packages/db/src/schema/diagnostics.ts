import { bigint, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

/**
 * Who did what, and when. Powers the audit trail under Diagnostics.
 *
 * Deliberately free of foreign keys: an audit row must outlive the user,
 * model or library it describes, so the actor's name and the target's label
 * are copied in at the time rather than joined later.
 */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    /** Dotted, category first: `model.updated`, `auth.login_failed`. */
    action: text('action').notNull(),
    /** `success`, or `failure` for an attempt that was refused. */
    outcome: text('outcome').notNull().default('success'),

    /** `user`, `system` (the worker, a schedule) or `anonymous` (not signed in). */
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id'),
    actorName: text('actor_name'),

    targetType: text('target_type'),
    targetId: text('target_id'),
    targetLabel: text('target_label'),

    /** Action-specific payload. Never secrets: see recordAudit(). */
    detail: jsonb('detail'),
    ip: text('ip'),
    /** Which process wrote it: `web` or `worker`. */
    source: text('source').notNull(),
  },
  (t) => [
    index('audit_events_occurred_idx').on(t.occurredAt),
    index('audit_events_action_idx').on(t.action, t.occurredAt),
    index('audit_events_actor_idx').on(t.actorId, t.occurredAt),
  ],
)

/**
 * Application log lines, captured from console output in both processes.
 *
 * In Postgres rather than a file because the web and worker containers share
 * a database and nothing else that can be relied on; this is what lets the
 * web UI show the worker's log.
 */
export const appLogs = pgTable(
  'app_logs',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    /** `debug`, `info`, `warn` or `error`. */
    level: text('level').notNull(),
    source: text('source').notNull(),
    /** The `[scope]` prefix the codebase already writes, when there is one. */
    scope: text('scope'),
    message: text('message').notNull(),
  },
  (t) => [index('app_logs_at_idx').on(t.at), index('app_logs_level_idx').on(t.level, t.at)],
)

/**
 * One row per running process, refreshed on a heartbeat. Tells the debug
 * report whether the worker is alive and which version each side is running.
 */
export const processStatus = pgTable('process_status', {
  source: text('source').primaryKey(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  seenAt: timestamp('seen_at', { withTimezone: true }).notNull().defaultNow(),
  info: jsonb('info').notNull(),
})
