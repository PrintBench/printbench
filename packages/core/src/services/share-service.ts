import { eq, isNotNull, sql } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import type { Database } from '@pb/db'
import { schema } from '@pb/db'

/**
 * Share links.
 *
 * A model is private until somebody shares it, and sharing mints a token that
 * is separate from `publicId`. That separation is the whole design: publicId is
 * the internal URL segment, so it is already known to everyone who can see the
 * model — building sharing on it would mean anyone who had ever been shown a
 * model could reach it again after their account was removed.
 *
 * A shared link grants exactly one thing: viewing that model and downloading
 * its files. Never the library, never search, never anything else.
 */

/**
 * 22 characters from nanoid's alphabet is ~131 bits. These links are unguessable
 * by design because there is no other access control on them — no rate limit
 * makes a short token safe when it can be tried offline against a URL.
 */
const TOKEN_LENGTH = 22

export interface SharedModel {
  id: string
  publicId: string
  name: string
  notes: string | null
  license: string | null
  creatorName: string | null
  sharedAt: Date
}

/** Mints a link, or returns the existing one so the URL stays stable. */
export async function shareModel(
  db: Database,
  modelId: string,
  userId: string,
): Promise<{ token: string; created: boolean }> {
  const rows = await db
    .select({ shareToken: schema.models.shareToken })
    .from(schema.models)
    .where(eq(schema.models.id, modelId))
    .limit(1)

  const existing = rows[0]?.shareToken
  // Re-sharing must not invalidate a link already sent to someone.
  if (existing) return { token: existing, created: false }

  const token = nanoid(TOKEN_LENGTH)
  await db
    .update(schema.models)
    .set({ shareToken: token, sharedAt: new Date(), sharedBy: userId })
    .where(eq(schema.models.id, modelId))

  return { token, created: true }
}

/**
 * Revokes the link.
 *
 * The token is discarded rather than remembered, so a future share mints a new
 * one and the revoked URL can never come back.
 */
export async function unshareModel(db: Database, modelId: string): Promise<void> {
  await db
    .update(schema.models)
    .set({ shareToken: null, sharedAt: null, sharedBy: null })
    .where(eq(schema.models.id, modelId))
}

/**
 * The model behind a share token, or null.
 *
 * Null covers every failure the same way — unknown token, revoked token,
 * model missing from disk — because distinguishing them for an anonymous
 * caller tells them which tokens once existed.
 */
export async function modelByShareToken(
  db: Database,
  token: string,
): Promise<SharedModel | null> {
  // Length-checked before the query: an absurd token is not worth an index scan.
  if (!token || token.length < 8 || token.length > 64) return null

  const rows = await db.execute<{
    id: string
    public_id: string
    name: string
    notes: string | null
    license: string | null
    creator_name: string | null
    shared_at: string
  }>(sql`
    SELECT m.id, m.public_id, m.name, m.notes, m.license, c.name AS creator_name, m.shared_at
    FROM models m
    LEFT JOIN creators c ON c.id = m.creator_id
    WHERE m.share_token = ${token} AND m.missing_at IS NULL
    LIMIT 1`)

  const row = rows.rows[0]
  if (!row) return null

  return {
    id: row.id,
    publicId: row.public_id,
    name: row.name,
    notes: row.notes,
    license: row.license,
    creatorName: row.creator_name,
    sharedAt: new Date(row.shared_at),
  }
}

/**
 * Whether one file may be served for one share token.
 *
 * Asked per file rather than trusting the page that linked it: without this,
 * a share token would be a way to fetch any file id at all, which is the whole
 * library.
 */
export async function shareTokenCoversFile(
  db: Database,
  token: string,
  fileId: string,
): Promise<boolean> {
  if (!token) return false

  const rows = await db.execute<{ ok: boolean }>(sql`
    SELECT true AS ok
    FROM model_files f
    JOIN models m ON m.id = f.model_id
    WHERE f.id = ${fileId} AND m.share_token = ${token}
      AND f.missing_at IS NULL AND m.missing_at IS NULL
    LIMIT 1`)

  return rows.rows.length > 0
}

/** Everything currently shared, so an admin can see and revoke it. */
export async function listSharedModels(
  db: Database,
): Promise<{ id: string; publicId: string; name: string; token: string; sharedAt: Date }[]> {
  const rows = await db
    .select({
      id: schema.models.id,
      publicId: schema.models.publicId,
      name: schema.models.name,
      token: schema.models.shareToken,
      sharedAt: schema.models.sharedAt,
    })
    .from(schema.models)
    .where(isNotNull(schema.models.shareToken))
    .limit(200)

  return rows
    .filter((row) => row.token && row.sharedAt)
    .map((row) => ({
      id: row.id,
      publicId: row.publicId,
      name: row.name,
      token: row.token!,
      sharedAt: row.sharedAt!,
    }))
}

/** Revokes every link at once — the "something has leaked" button. */
export async function revokeAllShares(db: Database): Promise<number> {
  const result = await db.execute(sql`
    UPDATE models SET share_token = NULL, shared_at = NULL, shared_by = NULL
    WHERE share_token IS NOT NULL`)
  return result.rowCount ?? 0
}
