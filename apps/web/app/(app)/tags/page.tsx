import Link from 'next/link'
import { Tags } from 'lucide-react'
import { can, listTags } from '@pb/core'
import { getSessionUser } from '@pb/auth'
import { getDb } from '@pb/db'
import { PageHeader } from '@/components/shell/page-header'
import { NotPermitted } from '@/components/shell/not-permitted'
import { EmptyState } from '@/components/ui/empty-state'
import { Button } from '@/components/ui/button'
import { TagManager } from './tag-manager'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Tags' }

export default async function TagsPage() {
  const user = await getSessionUser()
  const policyUser = { id: user?.id ?? '', role: user?.role ?? null }
  if (!can(policyUser, 'model:view')) return <NotPermitted what="tags" />

  const tags = await listTags(getDb())
  const used = tags.filter((tag) => tag.modelCount > 0).length

  return (
    <>
      <PageHeader
        title="Tags"
        description={
          tags.length === 0
            ? 'Tags you add to models appear here.'
            : `${tags.length} tag${tags.length === 1 ? '' : 's'}, ${used} in use`
        }
      />

      {tags.length === 0 ? (
        <EmptyState
          icon={<Tags className="size-6" />}
          title="No tags yet"
          description="Open a model, press Edit, and add a few. Tags are what make a large library searchable by anything other than name."
          action={
            <Button asChild variant="secondary">
              <Link href="/models">Browse models</Link>
            </Button>
          }
        />
      ) : (
        <TagManager tags={tags} canEdit={can(policyUser, 'tag:edit')} />
      )}
    </>
  )
}
