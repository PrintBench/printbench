import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import type { Database } from '@pb/db'
import { schema } from '@pb/db'
import { ROLE_ORDER, type Role } from '../policy/policy'

/**
 * Invitations.
 *
 * A self-hosted instance rarely has SMTP configured, so this does not send
 * anything. It mints a link, and the admin delivers it however they already
 * talk to that person. Building on email would mean the feature simply does
 * not work for most installations, which is the failure mode this whole
 * project exists to avoid.
 *
 * That makes the token the entire secret, so it is generated exactly as a
 * share token is: 22 characters of nanoid, ~131 bits, unguessable because
 * nothing else stands between the link and an account.
 */

const TOKEN_LENGTH = 22

/**
 * A fortnight. Long enough to survive someone being on holiday, short enough
 * that a link forwarded and forgotten does not stay live indefinitely.
 */
export const INVITE_TTL_DAYS = 14

export class InviteError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InviteError'
  }
}

export interface Invitation {
  id: string
  token: string
  email: string | null
  role: Role
  createdAt: Date
  expiresAt: Date
  invitedByName: string | null
}

/** What an unauthenticated visitor is allowed to learn from a token. */
export interface OpenInvitation {
  id: string
  email: string | null
  role: Role
}

export async function createInvite(
  db: Database,
  input: { email?: string | null; role: Role; createdBy: string },
): Promise<{ token: string }> {
  if (!ROLE_ORDER.includes(input.role)) throw new InviteError('Unknown role.')

  const email = input.email?.trim().toLowerCase() || null
  if (email && !email.includes('@')) throw new InviteError('That is not a valid email address.')

  if (email) {
    const existing = await db
      .select({ id: schema.user.id })
      .from(schema.user)
      .where(eq(schema.user.email, email))
      .limit(1)
    if (existing[0]) throw new InviteError('Someone with that email already has an account.')
  }

  const token = nanoid(TOKEN_LENGTH)
  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000)

  await db.insert(schema.invitations).values({
    token,
    email,
    role: input.role,
    createdBy: input.createdBy,
    expiresAt,
  })

  return { token }
}

/** Invitations still worth showing: not accepted, not revoked, not expired. */
export async function listPendingInvites(db: Database): Promise<Invitation[]> {
  const rows = await db.execute<{
    id: string
    token: string
    email: string | null
    role: string
    created_at: string
    expires_at: string
    invited_by_name: string | null
  }>(sql`
    SELECT i.id, i.token, i.email, i.role, i.created_at, i.expires_at,
           u.name AS invited_by_name
    FROM invitations i
    LEFT JOIN "user" u ON u.id = i.created_by
    WHERE i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()
    ORDER BY i.created_at DESC
    LIMIT 200`)

  return rows.rows.map((row) => ({
    id: row.id,
    token: row.token,
    email: row.email,
    role: row.role as Role,
    createdAt: new Date(row.created_at),
    expiresAt: new Date(row.expires_at),
    invitedByName: row.invited_by_name,
  }))
}

export async function revokeInvite(db: Database, id: string): Promise<boolean> {
  const result = await db
    .update(schema.invitations)
    .set({ revokedAt: new Date() })
    .where(and(eq(schema.invitations.id, id), isNull(schema.invitations.revokedAt)))
  return (result.rowCount ?? 0) > 0
}

/**
 * Resolves a token for the acceptance page.
 *
 * Returns null for anything unusable — unknown, revoked, already accepted or
 * expired — deliberately without saying which. An invitation link is a
 * credential, and distinguishing "expired" from "never existed" tells someone
 * probing tokens that they found a real one.
 */
export async function inviteByToken(
  db: Database,
  token: string,
): Promise<OpenInvitation | null> {
  if (!token || token.length > 64) return null

  const rows = await db
    .select({
      id: schema.invitations.id,
      email: schema.invitations.email,
      role: schema.invitations.role,
      acceptedAt: schema.invitations.acceptedAt,
      revokedAt: schema.invitations.revokedAt,
      expiresAt: schema.invitations.expiresAt,
    })
    .from(schema.invitations)
    .where(eq(schema.invitations.token, token))
    .limit(1)

  const invite = rows[0]
  if (!invite) return null
  if (invite.acceptedAt || invite.revokedAt) return null
  if (invite.expiresAt.getTime() <= Date.now()) return null

  return { id: invite.id, email: invite.email, role: invite.role as Role }
}

/**
 * Marks an invitation used, and refuses if it was used in the meantime.
 *
 * The conditional update is the whole point: two people opening the same link
 * at once must not both get an account. Whoever's UPDATE matches a row first
 * wins, and the other is told the link is spent.
 */
export async function consumeInvite(
  db: Database,
  id: string,
  userId: string,
): Promise<boolean> {
  const result = await db
    .update(schema.invitations)
    .set({ acceptedAt: new Date(), acceptedBy: userId })
    .where(
      and(
        eq(schema.invitations.id, id),
        isNull(schema.invitations.acceptedAt),
        isNull(schema.invitations.revokedAt),
        sql`${schema.invitations.expiresAt} > now()`,
      ),
    )
  return (result.rowCount ?? 0) > 0
}

/** Most recent first, for an audit trail on the users page. */
export async function recentlyAcceptedInvites(db: Database, limit = 20) {
  return db
    .select({
      id: schema.invitations.id,
      email: schema.invitations.email,
      acceptedAt: schema.invitations.acceptedAt,
      acceptedBy: schema.invitations.acceptedBy,
    })
    .from(schema.invitations)
    .where(sql`${schema.invitations.acceptedAt} IS NOT NULL`)
    .orderBy(desc(schema.invitations.acceptedAt))
    .limit(limit)
}
