import { desc } from 'drizzle-orm'
import { getSessionUser } from '@pm/auth'
import { can } from '@pm/core'
import { getDb, schema } from '@pm/db'
import { PageHeader } from '@/components/shell/page-header'
import { NotPermitted } from '@/components/shell/not-permitted'
import { PrinterList } from './printer-list'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Printers' }

export default async function PrintersPage() {
  const user = await getSessionUser()
  if (!can({ id: user?.id ?? '', role: user?.role ?? null }, 'printhost:manage')) {
    return <NotPermitted what="printer management" />
  }

  const hosts = await getDb()
    .select({
      id: schema.printHosts.id,
      name: schema.printHosts.name,
      protocol: schema.printHosts.protocol,
      endpoint: schema.printHosts.endpoint,
      credentials: schema.printHosts.credentials,
      lastSeenOk: schema.printHosts.lastSeenOk,
    })
    .from(schema.printHosts)
    .orderBy(desc(schema.printHosts.createdAt))

  return (
    <>
      <PageHeader
        title="Printers"
        description="Networked printers you can send a sliced file to. Bambu printers are driven through Bambu Studio instead — use Open in… on the model page."
      />

      <PrinterList
        hosts={hosts.map((host) => ({
          id: host.id,
          name: host.name,
          protocol: host.protocol,
          endpoint: host.endpoint,
          // Only whether a key exists ever reaches the browser, never the key.
          hasApiKey: host.credentials != null,
          lastSeenOk: host.lastSeenOk?.toISOString() ?? null,
        }))}
      />
    </>
  )
}
