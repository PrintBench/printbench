import { createHash, randomBytes } from 'node:crypto'
import { and, eq, gt, isNotNull } from 'drizzle-orm'
import { schema, type Database } from '@pb/db'
import { hashAccountPassword, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from './auth'

const RESET_PREFIX = 'printbench-password-reset:'
const RESET_TTL_MS = 60 * 60 * 1000
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/

export type PasswordRecoveryErrorCode = 'INVALID_TOKEN' | 'PASSWORD_LENGTH' | 'ACCOUNT_UNAVAILABLE'

export class PasswordRecoveryError extends Error {
  constructor(public readonly code: PasswordRecoveryErrorCode) {
    super(
      code === 'PASSWORD_LENGTH'
        ? `Password must contain ${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} characters.`
        : code === 'ACCOUNT_UNAVAILABLE'
          ? 'This account cannot use password recovery.'
          : 'This reset link is invalid or expired. Ask your administrator for a new link.',
    )
    this.name = 'PasswordRecoveryError'
  }
}

type RecoveryOptions = { now?: () => Date }

function tokenIdentifier(token: string): string {
  if (!TOKEN_PATTERN.test(token)) throw new PasswordRecoveryError('INVALID_TOKEN')
  return RESET_PREFIX + createHash('sha256').update(token).digest('hex')
}

function passwordFingerprint(passwordHash: string): string {
  return createHash('sha256').update(passwordHash).digest('hex')
}

function parseBinding(value: string): {
  userId: string
  accountId: string
  passwordFingerprint: string
} {
  try {
    const parsed: unknown = JSON.parse(value)
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'userId' in parsed &&
      typeof parsed.userId === 'string' &&
      'accountId' in parsed &&
      typeof parsed.accountId === 'string' &&
      'passwordFingerprint' in parsed &&
      typeof parsed.passwordFingerprint === 'string' &&
      /^[a-f0-9]{64}$/.test(parsed.passwordFingerprint)
    ) {
      return {
        userId: parsed.userId,
        accountId: parsed.accountId,
        passwordFingerprint: parsed.passwordFingerprint,
      }
    }
  } catch {
    // Treat malformed or unrelated verification records as unusable tokens.
  }
  throw new PasswordRecoveryError('INVALID_TOKEN')
}

/**
 * The caller must authorize the administrator (or local server operator) first.
 * Returns a secret once; only its SHA-256 digest is persisted. Issuing again
 * replaces the user's previous link. No mail service is required.
 */
export async function issuePasswordReset(
  db: Database,
  userId: string,
  options: RecoveryOptions = {},
): Promise<{ token: string; expiresAt: Date }> {
  return db.transaction(async (tx) => {
    // Serialize issuance and consumption for this user, including first issuance.
    const [user] = await tx
      .select()
      .from(schema.user)
      .where(eq(schema.user.id, userId))
      .for('update')
    if (!user || user.banned) throw new PasswordRecoveryError('ACCOUNT_UNAVAILABLE')
    const [account] = await tx
      .select()
      .from(schema.account)
      .where(
        and(
          eq(schema.account.userId, userId),
          eq(schema.account.providerId, 'credential'),
          isNotNull(schema.account.password),
        ),
      )
      .for('update')
    if (!account) throw new PasswordRecoveryError('ACCOUNT_UNAVAILABLE')

    const now = options.now?.() ?? new Date()
    const expiresAt = new Date(now.getTime() + RESET_TTL_MS)
    const token = randomBytes(32).toString('base64url')
    const id = RESET_PREFIX + userId
    await tx.delete(schema.verification).where(eq(schema.verification.id, id))
    await tx.insert(schema.verification).values({
      id,
      identifier: tokenIdentifier(token),
      value: JSON.stringify({
        userId,
        accountId: account.id,
        passwordFingerprint: passwordFingerprint(account.password!),
      }),
      expiresAt,
      createdAt: now,
      updatedAt: now,
    })
    return { token, expiresAt }
  })
}

/** Checks a link without consuming it. Public callers must not expose account data. */
export async function validatePasswordReset(
  db: Database,
  token: string,
  options: RecoveryOptions = {},
): Promise<void> {
  const identifier = tokenIdentifier(token)
  const now = options.now?.() ?? new Date()
  const [record] = await db
    .select()
    .from(schema.verification)
    .where(
      and(eq(schema.verification.identifier, identifier), gt(schema.verification.expiresAt, now)),
    )
  if (!record) throw new PasswordRecoveryError('INVALID_TOKEN')
  const binding = parseBinding(record.value)
  const [account] = await db
    .select({ password: schema.account.password })
    .from(schema.account)
    .innerJoin(schema.user, eq(schema.user.id, schema.account.userId))
    .where(
      and(
        eq(schema.user.id, binding.userId),
        eq(schema.user.banned, false),
        eq(schema.account.id, binding.accountId),
        eq(schema.account.providerId, 'credential'),
        isNotNull(schema.account.password),
      ),
    )
  if (!account?.password || passwordFingerprint(account.password) !== binding.passwordFingerprint) {
    throw new PasswordRecoveryError('INVALID_TOKEN')
  }
}

/** Password update, single-use consumption, and session revocation commit together. */
export async function resetPassword(
  db: Database,
  input: { token: string; password: string },
  options: RecoveryOptions = {},
): Promise<void> {
  const identifier = tokenIdentifier(input.token)
  if (input.password.length < PASSWORD_MIN_LENGTH || input.password.length > PASSWORD_MAX_LENGTH) {
    throw new PasswordRecoveryError('PASSWORD_LENGTH')
  }
  // Check before the expensive password hash; recheck under the user lock below.
  await validatePasswordReset(db, input.token, options)
  const password = await hashAccountPassword(input.password)

  await db.transaction(async (tx) => {
    const [candidate] = await tx
      .select()
      .from(schema.verification)
      .where(eq(schema.verification.identifier, identifier))
    if (!candidate) throw new PasswordRecoveryError('INVALID_TOKEN')
    const binding = parseBinding(candidate.value)
    const [user] = await tx
      .select()
      .from(schema.user)
      .where(eq(schema.user.id, binding.userId))
      .for('update')
    if (!user || user.banned) throw new PasswordRecoveryError('INVALID_TOKEN')

    const now = options.now?.() ?? new Date()
    // Another reset/issuance may have completed while this transaction waited.
    const [record] = await tx
      .select()
      .from(schema.verification)
      .where(
        and(
          eq(schema.verification.id, candidate.id),
          eq(schema.verification.identifier, identifier),
          gt(schema.verification.expiresAt, now),
        ),
      )
      .for('update')
    if (!record) throw new PasswordRecoveryError('INVALID_TOKEN')
    const [account] = await tx
      .select()
      .from(schema.account)
      .where(
        and(
          eq(schema.account.id, binding.accountId),
          eq(schema.account.userId, user.id),
          eq(schema.account.providerId, 'credential'),
          isNotNull(schema.account.password),
        ),
      )
      .for('update')
    if (
      !account?.password ||
      passwordFingerprint(account.password) !== binding.passwordFingerprint
    ) {
      throw new PasswordRecoveryError('INVALID_TOKEN')
    }

    await tx
      .update(schema.account)
      .set({ password, updatedAt: now })
      .where(eq(schema.account.id, account.id))
    await tx.delete(schema.session).where(eq(schema.session.userId, user.id))
    await tx.delete(schema.verification).where(eq(schema.verification.id, record.id))
  })
}
