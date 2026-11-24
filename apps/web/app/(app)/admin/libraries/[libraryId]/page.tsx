import { notFound } from 'next/navigation'
import { eq } from 'drizzle-orm'
import { getSessionUser } from '@pb/auth'
import { can, libraryLocationLabel, listS3Connections } from '@pb/core'
import { getDb, schema } from '@pb/db'
import { PageHeader } from '@/components/shell/page-header'
import { NotPermitted } from '@/components/shell/not-permitted'
import { EditLibraryForm } from './edit-library-form'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Edit library' }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export default async function EditLibraryPage({
  params,
}: {
  params: Promise<{ libraryId: string }>
}) {
  const user = await getSessionUser()
  if (!can({ id: user?.id ?? '', role: user?.role ?? null }, 'library:manage')) {
    return <NotPermitted what="library management" />
  }

  const { libraryId } = await params
  // A malformed id would otherwise reach Postgres as a uuid cast error.
  if (!UUID.test(libraryId)) notFound()

  const db = getDb()
  const [library] = await db
    .select({
      id: schema.libraries.id,
      name: schema.libraries.name,
      kind: schema.libraries.kind,
      backend: schema.libraries.backend,
      path: schema.libraries.path,
      s3Prefix: schema.libraries.s3Prefix,
      s3ConnectionId: schema.libraries.s3ConnectionId,
      writeSidecar: schema.libraries.writeSidecar,
      groupingMode: schema.libraries.groupingMode,
    })
    .from(schema.libraries)
    .where(eq(schema.libraries.id, libraryId))
    .limit(1)
  if (!library) notFound()

  const connections = library.backend === 's3' ? await listS3Connections(db) : []
  const current = connections.find((connection) => connection.id === library.s3ConnectionId)

  return (
    <>
      <PageHeader
        title={`Edit ${library.name}`}
        description="Change how this library is named and maintained. Where its files are stays fixed, so the models already indexed keep pointing at them."
      />
      <EditLibraryForm
        library={{
          id: library.id,
          name: library.name,
          kind: library.kind,
          backend: library.backend,
          path: library.path,
          prefix: library.s3Prefix,
          connectionId: library.s3ConnectionId,
          writeSidecar: library.writeSidecar,
          groupingMode: library.groupingMode,
          location: libraryLocationLabel({
            backend: library.backend,
            kind: library.kind,
            s3Endpoint: current?.endpoint,
            hasS3Connection: Boolean(current),
          }),
        }}
        /*
         * Only connections to the same bucket are offered: switching is for
         * changing which key reaches the files, not for moving them. With no
         * current connection (it was never set) every one is a candidate.
         */
        connections={connections
          .filter((connection) => !current || connection.bucket === current.bucket)
          .map(({ id, name, bucket, endpoint, accessKeyId }) => ({
            id,
            name,
            bucket,
            endpoint,
            credentials: accessKeyId ? `key ${accessKeyId}` : 'server credentials',
          }))}
      />
    </>
  )
}
