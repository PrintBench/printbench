import { getSessionUser } from '@pb/auth'
import { can } from '@pb/core'
import { PageHeader } from '@/components/shell/page-header'
import { NotPermitted } from '@/components/shell/not-permitted'
import { NewLibraryForm } from './new-library-form'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Add library' }

export default async function NewLibraryPage() {
  const user = await getSessionUser()
  if (!can({ id: user?.id ?? '', role: user?.role ?? null }, 'library:manage')) {
    return <NotPermitted what="library management" />
  }

  return (
    <>
      <PageHeader
        title="Add a library"
        description="Point PrintBench at a folder. It indexes what is there and never moves, renames or deletes your files."
      />
      <NewLibraryForm />
    </>
  )
}
