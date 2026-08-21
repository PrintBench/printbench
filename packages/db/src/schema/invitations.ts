import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { user } from './auth'

/**
 * Invitations to join this instance.
 *
 * Ours, not better-auth's — which is why it lives here rather than in
 * `auth.ts`, whose shape is dictated by the library.
 *
 * A self-hosted instance rarely has SMTP, so an invitation is a link the admin
 * copies and delivers themselves. The token is therefore the entire secret and
 * is minted the same way a share token is.
 */
export const invitations = pgTable(
  'invitations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    token: text('token').notNull().unique(),

    /** Optional: an invitation for a named person, or an open link. */
    email: text('email'),
    role: text('role').notNull().default('viewer'),

    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),

    /** Set when redeemed. Kept, so the list can show who used which link. */
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    acceptedBy: text('accepted_by').references(() => user.id, { onDelete: 'set null' }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [index('invitations_token_idx').on(t.token)],
)
