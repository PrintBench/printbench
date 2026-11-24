import { getSessionUser } from '@pb/auth'
import { can, catalogMaterials, catalogPicks, listFilaments, listSpools } from '@pb/core'
import { getDb } from '@pb/db'
import { NotPermitted } from '@/components/shell/not-permitted'
import { PageHeader } from '@/components/shell/page-header'
import { FilamentLibrary } from './library'
import { FilamentTabs } from './tabs'
export const dynamic = 'force-dynamic'
export const metadata = { title: 'Filaments' }
const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value)
export default async function FilamentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await getSessionUser()
  if (!can(user, 'filament:view')) return <NotPermitted what="the filament library" />
  const canManage = can(user, 'filament:manage')
  const raw = await searchParams
  const db = getDb()
  // `?add=<colour>&size=<spool>` comes from "Add spool" in the catalogue.
  const addVariant = canManage ? first(raw.add) : undefined
  const [spools, filaments, materials, picks] = await Promise.all([
    listSpools(db),
    listFilaments(db),
    catalogMaterials(db),
    addVariant ? catalogPicks(db, [addVariant]) : Promise.resolve([]),
  ])
  return (
    <>
      <PageHeader
        title="Filaments"
        description="Your spools, what’s left, and what you’ve printed with them."
      />
      <FilamentTabs active="spools" />
      <FilamentLibrary
        spools={spools}
        filaments={filaments}
        canManage={canManage}
        materials={materials}
        initialPick={picks[0] ?? null}
        initialSizeUuid={first(raw.size) ?? null}
      />
    </>
  )
}
