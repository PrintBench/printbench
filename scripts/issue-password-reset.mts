import { existsSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { eq } from 'drizzle-orm'
import { getDb, closeDb, schema } from '@pb/db'
import { issuePasswordReset } from '@pb/auth'

// Local server operators can recover the last admin without configuring SMTP.
// Never take a password on the command line or print a password/hash.
if (existsSync('.env')) process.loadEnvFile('.env')
try {
  const { values } = parseArgs({ options: { email: { type: 'string' } } })
  if (!values.email) throw new Error('Usage: npm run auth:reset -- --email your@email.example')
  const baseURL = process.env.BETTER_AUTH_URL?.trim() || process.env.APP_URL?.trim()
  if (!baseURL) throw new Error('Set APP_URL to your PrintBench address.')
  const url = new URL('/reset-password', baseURL)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('APP_URL must be a valid HTTP or HTTPS address.')
  const db = getDb()
  const [user] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, values.email.trim().toLowerCase()))
    .limit(1)
  if (!user) throw new Error('No account uses that email address.')
  const reset = await issuePasswordReset(db, user.id)
  url.searchParams.set('token', reset.token)
  process.stdout.write(
    `Private password reset link (expires ${reset.expiresAt.toISOString()}):\n${url.toString()}\n`,
  )
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'Could not issue a reset link.'}\n`,
  )
  process.exitCode = 1
} finally {
  await closeDb()
}
