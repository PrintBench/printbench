import { AsyncLocalStorage } from 'node:async_hooks'
import { and, eq } from 'drizzle-orm'
import { betterAuth } from 'better-auth'
import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api'
import { hashPassword, verifyPassword } from 'better-auth/crypto'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { admin } from 'better-auth/plugins/admin'
import { nextCookies } from 'better-auth/next-js'
import { recordAudit } from '@pb/core'
import { getDb, schema, type Database } from '@pb/db'
import { ROLES, type Role } from './roles'

/**
 * better-auth is wrapped so nothing else in the codebase imports it directly.
 * A breaking change upstream is then contained to this file.
 *
 * The worker process must never import this — auth is a web-tier concern.
 *
 * Built lazily: constructing it opens a database pool, and Next imports every
 * module during the build, where DATABASE_URL is legitimately absent. Deferring
 * to first request also means a database blip at boot does not kill the process.
 */
let instance: ReturnType<typeof createAuth> | undefined

export const PASSWORD_MIN_LENGTH = 10
export const PASSWORD_MAX_LENGTH = 200

/** Keep password encoding compatible with the configured authentication library. */
export const hashAccountPassword = hashPassword
export const verifyAccountPassword = verifyPassword

export function getAuth(): ReturnType<typeof createAuth> {
  instance ??= createAuth(getDb())
  return instance
}

function envUrl(name: string): string | undefined {
  const raw = process.env[name]?.trim().replace(/\/+$/, '')
  if (!raw) return undefined

  try {
    const { hostname } = new URL(raw)
    if (
      process.env.NODE_ENV === 'production' &&
      (hostname === 'localhost' || hostname === '127.0.0.1')
    ) {
      return undefined
    }
  } catch {
    return undefined
  }

  return raw
}

function configuredBaseUrl(): string | undefined {
  return envUrl('BETTER_AUTH_URL') ?? envUrl('APP_URL')
}

function trustedOrigins(): string[] {
  return [
    configuredBaseUrl(),
    ...(process.env.BETTER_AUTH_TRUSTED_ORIGINS ?? '')
      .split(',')
      .map((origin) => origin.trim().replace(/\/+$/, ''))
      .filter(Boolean),
  ].filter((origin): origin is string => Boolean(origin))
}

/** Builds the same auth instance against an explicit pool for isolated tests. */
export function createAuth(database: Database): ReturnType<typeof buildNativeAuth> {
  type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]
  const transactions = new AsyncLocalStorage<Transaction>()
  // The supported Drizzle adapter reads the supplied database on each operation.
  // Keep its queries (including new-session creation) in the credential lock's
  // transaction, while unrelated requests continue using the normal pool.
  const requestDatabase = new Proxy(database, {
    get(target, property) {
      const current = transactions.getStore() ?? target
      const value: unknown = Reflect.get(current, property, current)
      return typeof value === 'function' ? value.bind(current) : value
    },
  })

  const auth = buildNativeAuth(requestDatabase)

  class FailedAuthResponse extends Error {
    constructor(readonly response: Response) {
      super('Authentication endpoint failed')
    }
  }

  async function serializePasswordChange<T>(
    headers:
      | NonNullable<
          Parameters<ReturnType<typeof buildNativeAuth>['api']['getSession']>[0]
        >['headers']
      | undefined,
    run: () => Promise<T>,
  ): Promise<T> {
    if (!headers) return run()
    // Identify the cookie's user without refreshing it. The native endpoint
    // re-reads the session after the lock: a reset that won the race has revoked
    // it, and must not let this request verify an old hash or mint a new session.
    const session = await api.getSession({
      headers,
      query: { disableRefresh: true, disableCookieCache: true },
    })
    if (!session) return run()
    try {
      return await database.transaction(async (tx) => {
        await tx.select().from(schema.user).where(eq(schema.user.id, session.user.id)).for('update')
        await tx
          .select()
          .from(schema.account)
          .where(
            and(
              eq(schema.account.userId, session.user.id),
              eq(schema.account.providerId, 'credential'),
            ),
          )
          .for('update')
        return transactions.run(tx, async () => {
          const result = await run()
          // HTTP endpoints return error Responses instead of throwing. Ensure
          // a failed mutation also rolls back any writes preceding that error.
          if (result instanceof Response && !result.ok) throw new FailedAuthResponse(result)
          return result
        })
      })
    } catch (error) {
      if (error instanceof FailedAuthResponse) return error.response as T
      throw error
    }
  }

  const nativeChangePassword = auth.api.changePassword
  const api = {
    ...auth.api,
    changePassword: Object.assign(
      ((input: Parameters<typeof nativeChangePassword>[0]) =>
        serializePasswordChange(input?.headers ?? input?.request?.headers, () =>
          nativeChangePassword(input),
        )) as typeof nativeChangePassword,
      { path: nativeChangePassword.path, options: nativeChangePassword.options },
    ),
  }
  return {
    ...auth,
    api,
    handler: (request: Request): Promise<Response> => {
      const pathname = new URL(request.url).pathname.replace(/\/+$/, '')
      if (request.method === 'POST' && pathname.endsWith(nativeChangePassword.path)) {
        return serializePasswordChange(request.headers, () => auth.handler(request))
      }
      return auth.handler(request)
    },
  }
}

function buildNativeAuth(database: Database) {
  const baseURL = configuredBaseUrl()
  return betterAuth({
    appName: 'PrintBench',
    baseURL,
    trustedOrigins: trustedOrigins(),
    secret: process.env.BETTER_AUTH_SECRET,

    database: drizzleAdapter(database, {
      provider: 'pg',
      schema: {
        user: schema.user,
        session: schema.session,
        account: schema.account,
        verification: schema.verification,
      },
    }),

    emailAndPassword: {
      enabled: true,
      // Self-hosted instances rarely have SMTP configured. Requiring verification
      // by default would lock people out of their own server.
      requireEmailVerification: false,
      minPasswordLength: PASSWORD_MIN_LENGTH,
      maxPasswordLength: PASSWORD_MAX_LENGTH,
    },

    user: {
      additionalFields: {
        role: {
          type: 'string',
          required: false,
          defaultValue: 'viewer',
          // Never settable from the client: role changes go through the admin API.
          input: false,
        },
      },
    },

    session: {
      expiresIn: 60 * 60 * 24 * 30, // 30 days
      updateAge: 60 * 60 * 24, // refresh at most daily
      /*
       * Cookie caching is deliberately OFF.
       *
       * It stores the user record — including `role` — in a signed cookie and
       * serves it without touching the database. That makes role changes take
       * effect only after the cache expires, and the dangerous direction is
       * revocation: a demoted admin would keep admin rights until then.
       *
       * The cost of correctness is one indexed lookup per request, which is
       * nothing at this scale. Do not enable this without moving authorization
       * off the session payload.
       */
      cookieCache: { enabled: false },
    },

    advanced: {
      // Self-hosted deployments are frequently plain HTTP on a LAN.
      useSecureCookies: baseURL?.startsWith('https://') ?? false,
      // Coolify/Traefik and Cloudflare both forward the public request details.
      trustedProxyHeaders: true,
      ipAddress: {
        ipAddressHeaders: ['cf-connecting-ip', 'x-forwarded-for', 'x-real-ip'],
        trustedProxies: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.1'],
      },
    },

    /*
     * Sign-ins are recorded here rather than in the login form's code path
     * because this is the only place that sees every attempt, including the
     * ones made straight at the API by something that is not our form.
     */
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== '/sign-out') return
        // After the endpoint runs the session is gone, and with it the name.
        const current = await getSessionFromCtx(ctx).catch(() => null)
        if (!current) return
        await recordAudit(database, {
          action: 'auth.logout',
          actor: { type: 'user', id: current.user.id, name: current.user.name },
          ip: clientIp(ctx.headers),
        })
      }),
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== '/sign-in/email') return
        const created = ctx.context.newSession
        if (created) {
          await recordAudit(database, {
            action: 'auth.login',
            actor: { type: 'user', id: created.user.id, name: created.user.name },
            // The header first: the session stores IPv6 addresses masked to a prefix.
            ip: clientIp(ctx.headers) ?? created.session.ipAddress,
          })
          return
        }

        const returned = ctx.context.returned
        const body = ctx.body as { email?: unknown } | undefined
        await recordAudit(database, {
          action: 'auth.login_failed',
          outcome: 'failure',
          actor: { type: 'anonymous', name: attemptedEmail(body?.email) },
          detail: {
            reason: returned instanceof APIError ? returned.message : 'Sign-in was refused',
          },
          ip: clientIp(ctx.headers),
        })
      }),
    },

    plugins: [
      admin({ defaultRole: 'viewer', adminRoles: [ROLES.admin] }),
      // Must be last: lets server actions set cookies.
      nextCookies(),
    ],
  })
}

/** Same header order better-auth is configured with above. */
function clientIp(headers: Headers | undefined): string | null {
  for (const name of ['cf-connecting-ip', 'x-forwarded-for', 'x-real-ip']) {
    const value = headers?.get(name)?.split(',')[0]?.trim()
    if (value) return value
  }
  return null
}

/**
 * What was typed into the email box of a failed sign-in.
 *
 * Kept only when it is shaped like an address: people paste passwords into
 * the wrong field, and the audit trail must not become where those end up.
 */
function attemptedEmail(value: unknown): string {
  if (typeof value === 'string' && value.length <= 254 && /^[^\s@]+@[^\s@]+$/.test(value)) {
    return value.toLowerCase()
  }
  return '(not an email address)'
}

export type Auth = ReturnType<typeof createAuth>
export type Session = Auth['$Infer']['Session']
export type AuthUser = Session['user'] & { role?: Role | null }
