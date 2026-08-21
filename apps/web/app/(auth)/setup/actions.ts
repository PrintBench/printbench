'use server'

import { headers } from 'next/headers'
import { eq } from 'drizzle-orm'
import { getAuth } from '@pb/auth'
import { getDb, schema } from '@pb/db'
import { needsFirstRunSetup } from '@/lib/setup'

type Result = { ok: true } | { ok: false; error: string }

/**
 * Creates the first account and promotes it to admin.
 *
 * The zero-users check is re-run here, not just in the page: a page guard is a
 * rendering decision, and this action is directly callable.
 */
export async function createFirstAdmin(form: FormData): Promise<Result> {
  if (!(await needsFirstRunSetup())) {
    return { ok: false, error: 'Setup has already been completed.' }
  }

  const name = String(form.get('name') ?? '').trim()
  const email = String(form.get('email') ?? '')
    .trim()
    .toLowerCase()
  const password = String(form.get('password') ?? '')

  if (!name) return { ok: false, error: 'Please enter your name.' }
  if (!email.includes('@')) return { ok: false, error: 'Please enter a valid email address.' }
  if (password.length < 10) {
    return { ok: false, error: 'Password must be at least 10 characters.' }
  }

  try {
    // Signs up and sets the session cookie; nextCookies() makes that work here.
    const result = await getAuth().api.signUpEmail({
      body: { name, email, password },
      // Real request headers, so nextCookies() can attach the session cookie.
      headers: await headers(),
      asResponse: false,
    })

    // The admin plugin defaults new users to viewer, so promote explicitly.
    await getDb()
      .update(schema.user)
      .set({ role: 'admin', emailVerified: true })
      .where(eq(schema.user.id, result.user.id))

    return { ok: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not create the account.'
    return { ok: false, error: message }
  }
}
