import { randomUUID } from 'node:crypto'
import { and, count, eq, gt, lte, sql } from 'drizzle-orm'
import { z } from 'zod'
import { schema, type Database } from '@pb/db'
import { assertCan } from '../policy/policy'
import { decryptSecret, encryptSecret } from '../security/secret-box'
import {
  beginBambuSignIn,
  finishBambuSignIn,
  checkBambuToken,
  validateBambuCredentials,
  BambuSignInError,
  type BambuAuthRequest,
  type MakerWorldConnectionState,
} from './makerworld-auth'

const challengeIdentifier = (userId: string) => `printbench:makerworld:challenge:${userId}`
const attemptIdentifier = (userId: string) => `printbench:makerworld:attempt:${userId}`
const cooldownId = 'printbench:makerworld:sign-in-cooldown'
const challengeSchema = z.discriminatedUnion('method', [
  z.object({
    purpose: z.literal('makerworld-sign-in'),
    generation: z.string().uuid(),
    method: z.literal('email'),
    email: z.string().email().max(254),
  }),
  z.object({
    purpose: z.literal('makerworld-sign-in'),
    generation: z.string().uuid(),
    method: z.literal('authenticator'),
    tfaKey: z.string().min(1).max(1024),
  }),
])
export type MakerWorldSignInStatus =
  | { state: 'connected' | 'saved' }
  | { state: 'verification'; method: 'email' | 'authenticator'; challengeId: string }
export class MakerWorldChallengeError extends BambuSignInError {
  constructor(
    message: string,
    public readonly retryChallengeId: string | null = null,
  ) {
    super('rejected', message)
  }
}

async function authorize(db: Pick<Database, 'select'>, userId: string) {
  const [user] = await db.select().from(schema.user).where(eq(schema.user.id, userId)).limit(1)
  assertCan(user ?? null, 'file:upload')
}

/** Persisted counters are shared across web processes. No password, email, or code is logged. */
async function consumeAttempt(db: Database, userId: string) {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${attemptIdentifier(userId)}))`)
    const now = new Date()
    const [cooldown] = await tx
      .select()
      .from(schema.verification)
      .where(and(eq(schema.verification.id, cooldownId), gt(schema.verification.expiresAt, now)))
      .limit(1)
    if (cooldown)
      throw new BambuSignInError(
        'blocked',
        'Sign-in is paused for a few minutes after Bambu blocked a request. Wait before retrying, or use the advanced cookie method.',
      )
    const identifier = attemptIdentifier(userId)
    await tx
      .delete(schema.verification)
      .where(
        and(
          eq(schema.verification.identifier, identifier),
          lte(schema.verification.expiresAt, now),
        ),
      )
    const [attempts] = await tx
      .select({ total: count() })
      .from(schema.verification)
      .where(eq(schema.verification.identifier, identifier))
    if ((attempts?.total ?? 0) >= 8)
      throw new BambuSignInError(
        'blocked',
        'Too many sign-in attempts. Wait five minutes before trying again.',
      )
    await tx.insert(schema.verification).values({
      id: randomUUID(),
      identifier,
      value: 'attempt',
      expiresAt: new Date(now.getTime() + 5 * 60_000),
    })
  })
}

async function noteBlock(db: Database, error: unknown) {
  if (error instanceof BambuSignInError && error.code === 'blocked') {
    await db
      .insert(schema.verification)
      .values({
        id: cooldownId,
        identifier: cooldownId,
        value: 'blocked',
        expiresAt: new Date(Date.now() + 5 * 60_000),
      })
      .onConflictDoUpdate({
        target: schema.verification.id,
        set: { expiresAt: new Date(Date.now() + 5 * 60_000), updatedAt: new Date() },
      })
  }
}

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]
async function withLifecycleLock<T>(
  db: Database,
  userId: string,
  work: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${challengeIdentifier(userId)}))`)
    return work(tx)
  })
}
const missingChallenge = () =>
  new MakerWorldChallengeError('This sign-in has expired or was cancelled. Start again.')
async function requireGeneration(tx: Transaction, userId: string, generation: string) {
  const [guard] = await tx
    .select()
    .from(schema.verification)
    .where(
      and(
        eq(schema.verification.id, challengeIdentifier(userId)),
        eq(schema.verification.value, generation),
        gt(schema.verification.expiresAt, new Date()),
      ),
    )
    .limit(1)
  if (!guard) throw missingChallenge()
}

async function saveIssuedToken(
  db: Database,
  userId: string,
  token: string,
  generation: string,
  request?: BambuAuthRequest,
): Promise<MakerWorldSignInStatus> {
  // Cancellation or a newer login wins over an old in-flight response. No network call holds this lock.
  await withLifecycleLock(db, userId, async (tx) => {
    await authorize(tx, userId)
    await requireGeneration(tx, userId, generation)
    const encrypted = encryptSecret(token)
    await tx
      .insert(schema.providerCredentials)
      .values({ userId, makerWorldCookieEncrypted: encrypted })
      .onConflictDoUpdate({
        target: schema.providerCredentials.userId,
        set: { makerWorldCookieEncrypted: encrypted, updatedAt: new Date() },
      })
    await tx
      .delete(schema.verification)
      .where(eq(schema.verification.identifier, challengeIdentifier(userId)))
  })
  const status = await checkBambuToken(token, request)
  return { state: status === 'connected' ? 'connected' : 'saved' }
}

export async function startMakerWorldSignIn(
  db: Database,
  userId: string,
  email: string,
  password: string,
  request?: BambuAuthRequest,
): Promise<MakerWorldSignInStatus> {
  await authorize(db, userId)
  const credentials = validateBambuCredentials(email, password)
  // Fail before contacting Bambu if encrypted storage is unavailable.
  encryptSecret('makerworld-sign-in')
  await consumeAttempt(db, userId)
  const generation = randomUUID()
  const expiresAt = new Date(Date.now() + 10 * 60_000)
  await withLifecycleLock(db, userId, async (tx) => {
    await tx
      .delete(schema.verification)
      .where(eq(schema.verification.identifier, challengeIdentifier(userId)))
    await tx.insert(schema.verification).values({
      id: challengeIdentifier(userId),
      identifier: challengeIdentifier(userId),
      value: generation,
      expiresAt,
    })
  })
  try {
    const result = await beginBambuSignIn(credentials.email, credentials.password, request)
    if (result.state === 'authenticated')
      return saveIssuedToken(db, userId, result.token, generation, request)
    const challengeId = randomUUID()
    await withLifecycleLock(db, userId, async (tx) => {
      await requireGeneration(tx, userId, generation)
      await tx.insert(schema.verification).values({
        id: challengeId,
        identifier: challengeIdentifier(userId),
        value: encryptSecret(
          JSON.stringify({ purpose: 'makerworld-sign-in', generation, ...result.verification }),
        ),
        expiresAt,
      })
    })
    return { state: 'verification', method: result.verification.method, challengeId }
  } catch (error) {
    await noteBlock(db, error)
    await withLifecycleLock(db, userId, async (tx) => {
      await tx
        .delete(schema.verification)
        .where(
          and(
            eq(schema.verification.id, challengeIdentifier(userId)),
            eq(schema.verification.value, generation),
          ),
        )
    })
    throw error
  }
}

export async function verifyMakerWorldSignIn(
  db: Database,
  userId: string,
  challengeId: string,
  code: string,
  request?: BambuAuthRequest,
): Promise<MakerWorldSignInStatus> {
  await authorize(db, userId)
  if (!z.string().uuid().safeParse(challengeId).success || !/^\d{6}$/.test(code))
    throw new BambuSignInError('invalid', 'Enter the six-digit verification code.')
  await consumeAttempt(db, userId)
  // Claim atomically: a challenge cannot be used concurrently or replayed after success.
  const [row] = await db
    .delete(schema.verification)
    .where(
      and(
        eq(schema.verification.id, challengeId),
        eq(schema.verification.identifier, challengeIdentifier(userId)),
      ),
    )
    .returning()
  const missing = missingChallenge
  if (!row || row.expiresAt.getTime() <= Date.now()) throw missing()
  let challenge: z.infer<typeof challengeSchema>
  try {
    challenge = challengeSchema.parse(JSON.parse(decryptSecret(row.value) ?? 'null'))
  } catch {
    throw missing()
  }
  let token: string
  try {
    token = await finishBambuSignIn(challenge, code, request)
  } catch (error) {
    await noteBlock(db, error)
    // A wrong code/outage can be retried, but the old challenge ID remains consumed.
    if (error instanceof BambuSignInError && row.expiresAt.getTime() > Date.now()) {
      const retryChallengeId = randomUUID()
      await withLifecycleLock(db, userId, async (tx) => {
        await requireGeneration(tx, userId, challenge.generation)
        await tx.insert(schema.verification).values({
          id: retryChallengeId,
          identifier: row.identifier,
          value: row.value,
          expiresAt: row.expiresAt,
        })
      })
      throw new MakerWorldChallengeError(error.message, retryChallengeId)
    }
    throw error
  }
  return saveIssuedToken(db, userId, token, challenge.generation, request)
}

export async function cancelMakerWorldSignIn(db: Database, userId: string): Promise<void> {
  await authorize(db, userId)
  await withLifecycleLock(db, userId, async (tx) => {
    await tx
      .delete(schema.verification)
      .where(eq(schema.verification.identifier, challengeIdentifier(userId)))
  })
}

export async function checkMakerWorldConnection(
  db: Database,
  userId: string,
  request?: BambuAuthRequest,
): Promise<MakerWorldConnectionState> {
  await authorize(db, userId)
  const [row] = await db
    .select()
    .from(schema.providerCredentials)
    .where(eq(schema.providerCredentials.userId, userId))
    .limit(1)
  const token = decryptSecret(row?.makerWorldCookieEncrypted)
  if (!token) return 'not_connected'
  return checkBambuToken(token, request)
}
