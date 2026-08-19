import { getSessionUser } from '@pm/auth'
import { can } from '@pm/core'
import { PageHeader } from '@/components/shell/page-header'
import { NotPermitted } from '@/components/shell/not-permitted'
import { listUploadTargets } from './actions'
import { UploadDropzone } from './upload-dropzone'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Upload' }

export default async function UploadPage() {
  const user = await getSessionUser()
  if (!can({ id: user?.id ?? '', role: user?.role ?? null }, 'file:upload')) {
    return <NotPermitted what="uploading" />
  }

  const targets = await listUploadTargets()

  return (
    <>
      <PageHeader
        title="Upload"
        description="Add files to a managed library. Large uploads resume if the connection drops."
      />
      <div className="max-w-3xl">
        <UploadDropzone targets={targets} />
      </div>
    </>
  )
}
