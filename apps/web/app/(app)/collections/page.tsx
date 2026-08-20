import Link from 'next/link'
import { FolderTree } from 'lucide-react'
import { can, listCollections } from '@pm/core'
import { getSessionUser } from '@pm/auth'
import { getDb } from '@pm/db'
import { PageHeader } from '@/components/shell/page-header'
import { NotPermitted } from '@/components/shell/not-permitted'
import { EmptyState } from '@/components/ui/empty-state'
import { Button } from '@/components/ui/button'
import { CollectionList } from './collection-list'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Collections' }

export default async function CollectionsPage() {
  const user = await getSessionUser()
  const policyUser = { id: user?.id ?? '', role: user?.role ?? null }
  if (!can(policyUser, 'model:view')) return <NotPermitted what="collections" />

  const collections = await listCollections(getDb())
  const canEdit = can(policyUser, 'collection:edit')

  return (
    <>
      <PageHeader
        title="Collections"
        description="Group models however you like — a Kickstarter wave, a campaign, things to print next. A model can be in as many as you want."
      />

      {collections.length === 0 && !canEdit ? (
        <EmptyState
          icon={<FolderTree className="size-6" />}
          title="No collections yet"
          description="A member or admin can create them."
          action={
            <Button asChild variant="secondary">
              <Link href="/models">Browse models</Link>
            </Button>
          }
        />
      ) : (
        <CollectionList collections={collections} canEdit={canEdit} />
      )}
    </>
  )
}
