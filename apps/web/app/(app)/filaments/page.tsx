import { getSessionUser } from '@pb/auth'
import { can, listFilaments, listSpools } from '@pb/core'
import { getDb } from '@pb/db'
import { NotPermitted } from '@/components/shell/not-permitted'
import { PageHeader } from '@/components/shell/page-header'
import { FilamentLibrary } from './library'
export const dynamic = 'force-dynamic'
export const metadata = { title: 'Filaments' }
export default async function FilamentsPage() {
  const user = await getSessionUser()
  if (!can(user, 'filament:view')) return <NotPermitted what="the filament library" />
  const [spools, filaments] = await Promise.all([listSpools(getDb()), listFilaments(getDb())])
  return (
    <>
      <PageHeader
        title="Filaments"
        description="Your spools, what’s left, and what you’ve printed with them."
      />
      <FilamentLibrary
        spools={spools}
        filaments={filaments}
        canManage={can(user, 'filament:manage')}
      />
    </>
  )
}
