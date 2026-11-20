import 'server-only'

import { createHash, randomBytes } from 'node:crypto'
import { and, desc, eq, gt } from 'drizzle-orm'
import { schema, type Database } from '@pb/db'

const { clipperTokens, user } = schema
const maxAgeMs = 90 * 24 * 60 * 60 * 1000
const metadata = {
  id: clipperTokens.id,
  label: clipperTokens.label,
  createdAt: clipperTokens.createdAt,
  expiresAt: clipperTokens.expiresAt,
}

function hash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export async function createClipperToken(db: Database, userId: string, label: string) {
  const token = 'pb_clip_' + randomBytes(32).toString('base64url')
  const [entry] = await db
    .insert(clipperTokens)
    .values({
      userId,
      label,
      tokenHash: hash(token),
      expiresAt: new Date(Date.now() + maxAgeMs),
    })
    .returning(metadata)
  return { token, entry: entry! }
}

export function listClipperTokens(db: Database, userId: string) {
  return db
    .select(metadata)
    .from(clipperTokens)
    .where(eq(clipperTokens.userId, userId))
    .orderBy(desc(clipperTokens.createdAt))
}

export async function revokeClipperToken(db: Database, userId: string, id: string) {
  const [entry] = await db
    .delete(clipperTokens)
    .where(and(eq(clipperTokens.id, id), eq(clipperTokens.userId, userId)))
    .returning({ id: clipperTokens.id })
  return Boolean(entry)
}

export async function readClipperTokenUser(db: Database, authorization: string | null) {
  const token = authorization?.match(/^Bearer (pb_clip_[A-Za-z0-9_-]{43})$/i)?.[1]
  if (!token) return null
  const [owner] = await db
    .select({ id: user.id, name: user.name, role: user.role, banned: user.banned })
    .from(clipperTokens)
    .innerJoin(user, eq(clipperTokens.userId, user.id))
    .where(and(eq(clipperTokens.tokenHash, hash(token)), gt(clipperTokens.expiresAt, new Date())))
    .limit(1)
  return owner ?? null
}
