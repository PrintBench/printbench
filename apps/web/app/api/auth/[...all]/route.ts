import { getAuth } from '@pb/auth'

/**
 * Built per request rather than via toNextJsHandler at module scope: the auth
 * instance opens a database pool, and Next imports this module at build time
 * where DATABASE_URL is absent.
 */
export const dynamic = 'force-dynamic'

export function GET(request: Request): Promise<Response> {
  return getAuth().handler(request)
}

export function POST(request: Request): Promise<Response> {
  return getAuth().handler(request)
}
