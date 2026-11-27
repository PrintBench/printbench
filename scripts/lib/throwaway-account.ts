// The subpath, not the package root: the root also exports the Next.js
// session helpers, whose bare `next/headers` import Playwright cannot resolve.
import { createAuth } from '@pb/auth/auth'
import type { Database } from '@pb/db'

/**
 * Creates the throwaway account a verification script signs in with, and
 * returns its id.
 *
 * Public sign-up over HTTP is refused because PrintBench is invite-only, so
 * this takes the same route first-run setup and invitations take: better-auth's
 * sign-up called from server code. It is built on the script's own pool so
 * no second connection pool is left open when the script finishes.
 */
export async function createThrowawayAccount(
  db: Database,
  input: { name: string; email: string; password: string },
): Promise<string> {
  const { user } = await createAuth(db).api.signUpEmail({ body: input })
  return user.id
}
