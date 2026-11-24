import { getSessionUser } from '@pb/auth'
import { can, listS3Connections } from '@pb/core'
import { getDb } from '@pb/db'
import { PageHeader } from '@/components/shell/page-header'
import { NotPermitted } from '@/components/shell/not-permitted'
import { NewLibraryForm } from './new-library-form'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Add library' }

export default async function NewLibraryPage({
  searchParams,
}: {
  searchParams: Promise<{ connection?: string }>
}) {
  const user = await getSessionUser()
  if (!can({ id: user?.id ?? '', role: user?.role ?? null }, 'library:manage')) {
    return <NotPermitted what="library management" />
  }

  const { connection } = await searchParams
  const connections = await listS3Connections(getDb())

  return (
    <>
      <PageHeader
        title="Add a library"
        description="Point PrintBench at a folder. It indexes what is there and never moves, renames or deletes your files."
      />
      <NewLibraryForm
        connections={connections.map(({ id, name, bucket, endpoint }) => ({
          id,
          name,
          bucket,
          endpoint,
        }))}
        initialConnectionId={connection}
      />
    </>
  )
}
