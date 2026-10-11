import { AUDIT_CATEGORIES, auditEventsToCsv, listAuditEvents, type AuditCategory } from '@pb/core'
import { getDb } from '@pb/db'
import { audit } from '@/lib/audit'
import { diagnosticsUser, fileStamp, forbidden } from '@/lib/diagnostics'

export const dynamic = 'force-dynamic'

/** Enough for years on a home instance, and bounded so it cannot exhaust memory. */
const EXPORT_LIMIT = 5000

/** The audit trail as CSV, honouring the same filters as the page. */
export async function GET(request: Request): Promise<Response> {
  const user = await diagnosticsUser()
  if (!user) return forbidden()

  const params = new URL(request.url).searchParams
  const category = params.get('category') ?? ''
  const outcome = params.get('outcome')

  const { events } = await listAuditEvents(getDb(), {
    category: category in AUDIT_CATEGORIES ? (category as AuditCategory) : undefined,
    outcome: outcome === 'failure' || outcome === 'success' ? outcome : undefined,
    query: params.get('q')?.slice(0, 200) || undefined,
    limit: EXPORT_LIMIT,
  })

  await audit(
    user,
    'diagnostics.exported',
    { type: 'audit', label: 'Audit trail' },
    {
      events: events.length,
    },
  )

  return new Response(auditEventsToCsv(events), {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="printbench-audit-${fileStamp()}.csv"`,
      'cache-control': 'no-store',
    },
  })
}
