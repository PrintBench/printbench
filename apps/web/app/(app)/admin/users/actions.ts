'use server'

import { headers } from 'next/headers'
import { eq, and, ne, sql } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import {
  InviteError,
  assertCan,
  createInvite,
  revokeInvite,
  PolicyError,
  ROLE_ORDER,
  type Role,
} from '@pb/core'
import { getAuth, requireUser } from '@pb/auth'
import { getDb, schema } from '@pb/db'

type Result = { ok: true } | { ok: false; error: string }
type InviteResult = { ok: true; token: string } | { ok: false; error: string }

/** Every action here is admin-only, and re-checks rather than trusting the page. */
async function requireAdmin() {
  const actor = await requireUser()
  assertCan({ id: actor.id, role: actor.role ?? null, banned: actor.banned ?? false }, 'user:manage')
  return actor
}

/**
 * Refuses a change that would leave the instance with no admin.
 *
 * Checked before demoting, suspending or deleting an admin — all three
 * arrive at the same lockout, and it is unrecoverable through the UI because
 * the UI needs an admin to reach.
 */
async function wouldStrandInstance(userId: string): Promise<boolean> {
  const rows = await getDb().execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM "user"
    WHERE role = 'admin' AND banned = false AND id <> ${userId}`)
  return (rows.rows[0]?.n ?? 0) === 0
}

function fail(error: unknown, fallback: string): { ok: false; error: string } {
  if (error instanceof PolicyError) return { ok: false, error: 'Not permitted.' }
  if (error instanceof InviteError) return { ok: false, error: error.message }
  console.error('[users]', error)
  return { ok: false, error: fallback }
}

export async function setUserRole(userId: string, role: string): Promise<Result> {
  try {
    const actor = await requireAdmin()

    if (!ROLE_ORDER.includes(role as Role)) {
      return { ok: false, error: 'Unknown role.' }
    }

    // Changing your own role is how an instance ends up with no admin at all.
    if (userId === actor.id) {
      return { ok: false, error: 'You cannot change your own role.' }
    }

    const db = getDb()

    // Belt and braces: refuse if this would leave zero admins.
    if (role !== 'admin' && (await wouldStrandInstance(userId))) {
      return { ok: false, error: 'There must be at least one admin.' }
    }

    const updated = await db
      .update(schema.user)
      .set({ role, updatedAt: new Date() })
      .where(and(eq(schema.user.id, userId), ne(schema.user.id, actor.id)))

    /*
     * An UPDATE matching nothing is not success. Without this the UI reports a
     * role change that never happened — which is what you get when the account
     * was removed in another tab.
     */
    if (updated.rowCount === 0) return { ok: false, error: 'That account no longer exists.' }

    revalidatePath('/admin/users')
    return { ok: true }
  } catch (error) {
    return fail(error, 'Could not update the role.')
  }
}

/**
 * Creates an account directly, for an admin who would rather hand someone a
 * password than a link.
 *
 * Goes through better-auth's admin API rather than signUpEmail: signing up
 * issues a session cookie, which in a server action would sign the ADMIN into
 * the account they just created for somebody else.
 */
export async function addUser(input: {
  name: string
  email: string
  password: string
  role: string
}): Promise<Result> {
  try {
    await requireAdmin()

    const name = input.name.trim()
    const email = input.email.trim().toLowerCase()

    if (!name) return { ok: false, error: 'Give the person a name.' }
    if (!email.includes('@')) return { ok: false, error: 'That is not a valid email address.' }
    if (input.password.length < 10) {
      return { ok: false, error: 'The password must be at least 10 characters.' }
    }
    if (!ROLE_ORDER.includes(input.role as Role)) return { ok: false, error: 'Unknown role.' }

    const existing = await getDb()
      .select({ id: schema.user.id })
      .from(schema.user)
      .where(eq(schema.user.email, email))
      .limit(1)
    if (existing[0]) return { ok: false, error: 'Someone with that email already has an account.' }

    const created = await getAuth().api.createUser({
      body: { name, email, password: input.password },
      headers: await headers(),
    })

    /*
     * Role set here rather than passed to createUser. better-auth types its
     * role parameter against its own union, and our roles are ours — setting
     * it directly keeps that coupling out of the call, exactly as first-run
     * setup does when it promotes the initial admin.
     */
    await getDb()
      .update(schema.user)
      .set({ role: input.role, emailVerified: true })
      .where(eq(schema.user.id, created.user.id))

    revalidatePath('/admin/users')
    return { ok: true }
  } catch (error) {
    return fail(error, 'Could not create that account.')
  }
}

/** Name and email. Role has its own control; passwords are set by their owner. */
export async function updateUser(
  userId: string,
  input: { name: string; email: string },
): Promise<Result> {
  try {
    await requireAdmin()

    const name = input.name.trim()
    const email = input.email.trim().toLowerCase()
    if (!name) return { ok: false, error: 'A name is required.' }
    if (!email.includes('@')) return { ok: false, error: 'That is not a valid email address.' }

    const db = getDb()
    const clash = await db
      .select({ id: schema.user.id })
      .from(schema.user)
      .where(and(eq(schema.user.email, email), ne(schema.user.id, userId)))
      .limit(1)
    if (clash[0]) return { ok: false, error: 'Another account already uses that email.' }

    const updated = await db
      .update(schema.user)
      .set({ name, email, updatedAt: new Date() })
      .where(eq(schema.user.id, userId))

    if (updated.rowCount === 0) return { ok: false, error: 'That account no longer exists.' }

    revalidatePath('/admin/users')
    return { ok: true }
  } catch (error) {
    return fail(error, 'Could not save those details.')
  }
}

/**
 * Suspends or restores an account.
 *
 * Suspending also drops the sessions. Leaving them alive would mean a
 * suspended person keeps working until their cookie expires, which is the
 * opposite of what suspending is for.
 */
export async function setSuspended(userId: string, suspended: boolean): Promise<Result> {
  try {
    const actor = await requireAdmin()

    if (userId === actor.id) {
      return { ok: false, error: 'You cannot suspend your own account.' }
    }
    if (suspended && (await wouldStrandInstance(userId))) {
      return { ok: false, error: 'There must be at least one admin who is not suspended.' }
    }

    const db = getDb()
    const updated = await db
      .update(schema.user)
      .set({ banned: suspended, banReason: suspended ? 'Suspended by an admin' : null, updatedAt: new Date() })
      .where(eq(schema.user.id, userId))

    if (updated.rowCount === 0) return { ok: false, error: 'That account no longer exists.' }

    if (suspended) {
      await db.delete(schema.session).where(eq(schema.session.userId, userId))
    }

    revalidatePath('/admin/users')
    return { ok: true }
  } catch (error) {
    return fail(error, 'Could not change that account.')
  }
}

/**
 * Deletes an account.
 *
 * What the person made stays: models, tags and print history reference the
 * user only loosely, and taking someone's catalogue work with them when they
 * leave the team would be a surprising thing for a delete button to do.
 */
export async function deleteUser(userId: string): Promise<Result> {
  try {
    const actor = await requireAdmin()

    if (userId === actor.id) {
      return { ok: false, error: 'You cannot delete your own account.' }
    }
    if (await wouldStrandInstance(userId)) {
      return { ok: false, error: 'There must be at least one admin.' }
    }

    const removed = await getDb().delete(schema.user).where(eq(schema.user.id, userId))
    if (removed.rowCount === 0) return { ok: false, error: 'That account no longer exists.' }

    revalidatePath('/admin/users')
    return { ok: true }
  } catch (error) {
    return fail(error, 'Could not delete that account.')
  }
}

/** Mints an invitation link. Nothing is emailed — see the invite service. */
export async function invite(input: { email?: string; role: string }): Promise<InviteResult> {
  try {
    const actor = await requireAdmin()

    if (!ROLE_ORDER.includes(input.role as Role)) return { ok: false, error: 'Unknown role.' }

    const { token } = await createInvite(getDb(), {
      email: input.email,
      role: input.role as Role,
      createdBy: actor.id,
    })

    revalidatePath('/admin/users')
    return { ok: true, token }
  } catch (error) {
    return fail(error, 'Could not create an invitation.')
  }
}

export async function cancelInvite(id: string): Promise<Result> {
  try {
    await requireAdmin()
    const revoked = await revokeInvite(getDb(), id)
    if (!revoked) return { ok: false, error: 'That invitation is no longer active.' }

    revalidatePath('/admin/users')
    return { ok: true }
  } catch (error) {
    return fail(error, 'Could not cancel that invitation.')
  }
}
