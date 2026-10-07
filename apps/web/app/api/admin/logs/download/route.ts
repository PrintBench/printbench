import { formatLogLines, isLogLevel, listLogs } from '@pb/core'
import { getDb } from '@pb/db'
import { audit } from '@/lib/audit'
import { diagnosticsUser, fileStamp, forbidden } from '@/lib/diagnostics'

export const dynamic = 'force-dynamic'

const DOWNLOAD_LIMIT = 10_000

/** The most recent matching log lines as plain text, oldest first. */
export async function GET(request: Request): Promise<Response> {
  const user = await diagnosticsUser()
  if (!user) return forbidden()

  const params = new URL(request.url).searchParams
  const level = params.get('level')
  const source = params.get('source')

  const entries = await listLogs(getDb(), {
    minLevel: isLogLevel(level) ? level : undefined,
    source: source === 'web' || source === 'worker' ? source : undefined,
    query: params.get('q')?.slice(0, 200) || undefined,
    limit: DOWNLOAD_LIMIT,
  })

  await audit(
    user,
    'diagnostics.exported',
    { type: 'logs', label: 'Application logs' },
    {
      lines: entries.length,
    },
  )

  return new Response(formatLogLines(entries) + '\n', {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'content-disposition': `attachment; filename="printbench-logs-${fileStamp()}.log"`,
      'cache-control': 'no-store',
    },
  })
}
