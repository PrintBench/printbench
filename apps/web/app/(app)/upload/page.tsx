import { getSessionUser } from '@pb/auth'
import { can } from '@pb/core'
import { PageHeader } from '@/components/shell/page-header'
import { NotPermitted } from '@/components/shell/not-permitted'
import { listUploadTargets } from './actions'
import { UploadDropzone } from './upload-dropzone'
import { ModelSourceImportForm } from './model-source-import-form'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Upload' }

export default async function UploadPage() {
  const user = await getSessionUser()
  if (
    !can(
      { id: user?.id ?? '', role: user?.role ?? null, banned: user?.banned ?? false },
      'file:upload',
    )
  ) {
    return <NotPermitted what="uploading" />
  }

  const targets = await listUploadTargets()

  return (
    <>
      <PageHeader
        title="Upload"
        description="Upload files or import a MakerWorld, Printables, or Thingiverse model into a writable library."
      />
      <div className="max-w-3xl space-y-6">
        <ModelSourceImportForm targets={targets} />
        <section aria-labelledby="local-upload-heading" className="space-y-3">
          <div>
            <h2 id="local-upload-heading" className="text-lg font-semibold">
              Upload local files
            </h2>
            <p className="mt-1 text-sm text-[var(--color-ink-muted)]">
              Details embedded in new 3MF uploads can fill in model metadata automatically. Large
              uploads resume if the connection drops.
            </p>
          </div>
          <UploadDropzone targets={targets} />
        </section>
      </div>
    </>
  )
}
