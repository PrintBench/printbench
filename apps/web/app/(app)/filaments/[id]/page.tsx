import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getSessionUser } from '@pb/auth'
import { can, listFilaments, listSpools, spoolHistory, spoolPrints } from '@pb/core'
import { getDb } from '@pb/db'
import { NotPermitted } from '@/components/shell/not-permitted'
import { PageHeader } from '@/components/shell/page-header'
import { SpoolDetails } from '../spool-details'
export const dynamic = 'force-dynamic'
export const metadata = { title: 'Spool' }
export default async function SpoolPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser()
  if (!can(user, 'filament:view')) return <NotPermitted what="the filament library" />
  const { id } = await params
  const spools = await listSpools(getDb())
  const spool = spools.find((s) => s.id === id)
  if (!spool) notFound()
  const [history, filaments, prints] = await Promise.all([
    spoolHistory(getDb(), id),
    listFilaments(getDb()),
    spoolPrints(getDb(), id),
  ])
  return (
    <>
      <Link href="/filaments" className="mb-4 inline-block text-sm text-[var(--color-accent)]">
        ← Filaments
      </Link>
      <PageHeader
        title={spool.label || spool.filament.name}
        description={[spool.filament.brand, spool.filament.material, spool.filament.colorName]
          .filter(Boolean)
          .join(' · ')}
      />
      <SpoolDetails
        spool={spool}
        filaments={filaments}
        history={history}
        prints={prints}
        canManage={can(user, 'filament:manage')}
      />
    </>
  )
}
