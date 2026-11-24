import { getSessionUser } from '@pb/auth'
import { can, listS3Connections } from '@pb/core'
import { getDb } from '@pb/db'
import { PageHeader } from '@/components/shell/page-header'
import { NotPermitted } from '@/components/shell/not-permitted'
import { ConnectionList } from './connection-list'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Storage' }

export default async function StoragePage() {
  const user = await getSessionUser()
  if (!can({ id: user?.id ?? '', role: user?.role ?? null }, 'library:manage')) {
    return <NotPermitted what="storage management" />
  }

  // Secrets are left out by listS3Connections; only whether one is stored is sent.
  const connections = await listS3Connections(getDb())

  return (
    <>
      <PageHeader
        title="Storage"
        description="S3 buckets and the keys that reach them. Set one up once, then use it for as many libraries as you like, each indexing its own prefix. Rotate or remove a key here and every library on it follows."
      />
      <ConnectionList connections={connections} />
    </>
  )
}
