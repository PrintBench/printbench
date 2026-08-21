import Link from 'next/link'
import { Heart } from 'lucide-react'
import { can, listLiked } from '@pb/core'
import { getSessionUser } from '@pb/auth'
import { getDb } from '@pb/db'
import { PageHeader } from '@/components/shell/page-header'
import { NotPermitted } from '@/components/shell/not-permitted'
import { EmptyState } from '@/components/ui/empty-state'
import { Button } from '@/components/ui/button'
import { ModelCard } from '@/components/model/model-card'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Liked' }

export default async function LikedPage() {
  const user = await getSessionUser()
  if (!user || !can({ id: user.id, role: user.role ?? null }, 'like:toggle')) {
    return <NotPermitted what="liked models" />
  }

  const liked = await listLiked(getDb(), user.id)

  return (
    <>
      <PageHeader
        title="Liked"
        description={
          liked.length === 0
            ? 'Models you have hearted appear here.'
            : `${liked.length} model${liked.length === 1 ? '' : 's'}, most recent first`
        }
      />

      {liked.length === 0 ? (
        <EmptyState
          icon={<Heart className="size-6" />}
          title="Nothing liked yet"
          description="Press the heart on any model to keep it here. Only you can see this list."
          action={
            <Button asChild variant="secondary">
              <Link href="/models">Browse models</Link>
            </Button>
          }
        />
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-4">
          {liked.map((model) => (
            <ModelCard
              key={model.id}
              publicId={model.publicId}
              name={model.name}
              path={model.path}
              fileCount={model.fileCount}
              totalSize={model.totalSize}
              libraryName={model.libraryName}
              thumbFileId={model.thumbFileId}
            />
          ))}
        </div>
      )}
    </>
  )
}
