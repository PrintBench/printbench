'use server'

import { headers } from 'next/headers'
import { eq } from 'drizzle-orm'
import { consumeInvite, inviteByToken } from '@pm/core'
import { getAuth } from '@pm/auth'
import { getDb, schema } from '@pm/db'

type Result = { ok: true } | { ok: false; error: string }

/**
 * Redeems an invitation and creates the account.
 *
 * Deliberately unauthenticated — the token IS the authorisation, and it is
 * re-resolved here rather than trusted from the form. A hidden field naming
 * the role would let anyone who found the page award themselves admin.
 */
export async function acceptInvite(form: FormData): Promise<Result> {
  const token = String(form.get('token') ?? '')
  const name = String(form.get('name') ?? '').trim()
  const password = String(form.get('password') ?? '')
  const submittedEmail = String(form.get('email') ?? '')
    .trim()
    .toLowerCase()

  const db = getDb()
  const invitation = await inviteByToken(db, token)
  if (!invitation) {
    return { ok: false, error: 'This invitation is no longer valid. Ask for a new link.' }
  }

  /*
   * An invitation addressed to someone is for that person. An open one lets
   * the holder choose, since there was no address to honour in the first
   * place.
   */
  const email = invitation.email ?? submittedEmail

  if (!name) return { ok: false, error: 'Please enter your name.' }
  if (!email.includes('@')) return { ok: false, error: 'Please enter a valid email address.' }
  if (password.length < 10) {
    return { ok: false, error: 'Password must be at least 10 characters.' }
  }

  const taken = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, email))
    .limit(1)
  if (taken[0]) {
    return { ok: false, error: 'An account with that email already exists. Try signing in.' }
  }

  try {
    // Signs up AND signs in: this person is redeeming their own invitation, so
    // landing them in the app is the point. nextCookies() attaches the session.
    const result = await getAuth().api.signUpEmail({
      body: { name, email, password },
      headers: await headers(),
      asResponse: false,
    })

    /*
     * The invitation is spent BEFORE the role is granted, and the account is
     * removed again if it was already spent. Two people opening the same link
     * at once must not both end up with the role it carried.
     */
    const consumed = await consumeInvite(db, invitation.id, result.user.id)
    if (!consumed) {
      await db.delete(schema.user).where(eq(schema.user.id, result.user.id))
      return { ok: false, error: 'That invitation has just been used. Ask for a new link.' }
    }

    await db
      .update(schema.user)
      .set({ role: invitation.role, emailVerified: true })
      .where(eq(schema.user.id, result.user.id))

    return { ok: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not create the account.'
    return { ok: false, error: message }
  }
}
