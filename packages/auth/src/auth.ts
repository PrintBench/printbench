import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { admin } from 'better-auth/plugins/admin'
import { nextCookies } from 'better-auth/next-js'
import { getDb, schema } from '@pb/db'
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
let instance: ReturnType<typeof build> | undefined

export function getAuth(): ReturnType<typeof build> {
  instance ??= build()
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

function build() {
  const baseURL = configuredBaseUrl()

  return betterAuth({
    appName: 'PrintBench',
    baseURL,
    trustedOrigins: trustedOrigins(),
    secret: process.env.BETTER_AUTH_SECRET,

    database: drizzleAdapter(getDb(), {
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
      minPasswordLength: 10,
      maxPasswordLength: 200,
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

    plugins: [
      admin({ defaultRole: 'viewer', adminRoles: [ROLES.admin] }),
      // Must be last: lets server actions set cookies.
      nextCookies(),
    ],
  })
}

export type Auth = ReturnType<typeof build>
export type Session = Auth['$Infer']['Session']
export type AuthUser = Session['user'] & { role?: Role | null }
