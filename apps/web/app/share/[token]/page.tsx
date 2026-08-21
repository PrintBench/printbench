import { notFound } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { Box, FileStack } from 'lucide-react'
import { getSettings, modelByShareToken } from '@pb/core'
import { getDb } from '@pb/db'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { formatBytes } from '@/components/model/model-card'
import { ShareViewer } from './share-viewer'

export const dynamic = 'force-dynamic'

/**
 * A shared model, viewable without an account.
 *
 * Everything on this page is scoped to the one model the token names. There is
 * no navigation, no search and no link back into the app, because a share link
 * grants exactly one model — anything else here would be a way to explore the
 * library from outside it.
 */

type FileRow = {
  id: string
  filename: string
  extension: string
  category: string
  size: string
  thumb_state: string
}

export async function generateMetadata({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const db = getDb()

  const { publicSharing } = await getSettings(db)
  if (!publicSharing) return { title: 'Not available' }

  const model = await modelByShareToken(db, token)
  return {
    title: model ? `${model.name} · Shared` : 'Not available',
    // A shared link should not end up in a search index.
    robots: { index: false, follow: false },
  }
}

export default async function SharePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const db = getDb()

  /*
   * The instance-wide switch is checked first and fails the same way as a bad
   * token. Turning sharing off must close existing links immediately, without
   * having to revoke each one.
   */
  const { publicSharing, siteName } = await getSettings(db)
  if (!publicSharing) notFound()

  const model = await modelByShareToken(db, token)
  if (!model) notFound()

  const files = await db.execute<FileRow>(sql`
    SELECT id, filename, extension, category, size, thumb_state
    FROM model_files
    WHERE model_id = ${model.id} AND missing_at IS NULL
    ORDER BY category, filename`)

  const totalSize = files.rows.reduce((sum, file) => sum + Number(file.size), 0)
  const hero = files.rows
    .filter((file) => file.thumb_state === 'ok')
    .sort((a, b) => Number(b.size) - Number(a.size))[0]

  const VIEWABLE = new Set(['stl', '3mf', 'obj', 'ply'])
  const viewable = files.rows
    .filter((file) => VIEWABLE.has(file.extension.toLowerCase()))
    .sort((a, b) => Number(b.size) - Number(a.size))[0]

  return (
    <main className="mx-auto max-w-4xl px-5 py-10 sm:px-8">
      <header className="mb-6">
        <p className="text-xs uppercase tracking-wide text-[var(--color-ink-faint)]">
          Shared from {siteName}
        </p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">{model.name}</h1>
        {model.creatorName && (
          <p className="mt-1 text-sm text-[var(--color-ink-muted)]">by {model.creatorName}</p>
        )}
        {model.notes && (
          <p className="mt-3 max-w-2xl text-sm text-[var(--color-ink-muted)]">{model.notes}</p>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Badge tone="neutral">
            <FileStack className="size-3" />
            {files.rows.length} files · {formatBytes(totalSize)}
          </Badge>
          {model.license && <Badge tone="neutral">{model.license}</Badge>}
        </div>
      </header>

      <ShareViewer
        token={token}
        fileId={viewable?.id ?? null}
        format={(viewable?.extension.toLowerCase() ?? 'stl') as 'stl' | '3mf' | 'obj' | 'ply'}
        fileSize={Number(viewable?.size ?? 0)}
        filename={viewable?.filename ?? ''}
        thumbnailFileId={hero?.id ?? null}
      />

      <section className="mt-6">
        <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold">
          <Box className="size-4" />
          Files
        </h2>
        <Card className="overflow-hidden">
          <ul className="divide-y divide-[var(--color-border)]">
            {files.rows.map((file) => (
              <li key={file.id} className="flex items-center gap-3 px-4 py-2.5">
                <span className="w-10 shrink-0 rounded bg-[var(--color-surface-2)] px-1.5 py-0.5 text-center text-[10px] font-medium uppercase text-[var(--color-ink-faint)]">
                  {file.extension || '—'}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm">{file.filename}</span>
                <span className="shrink-0 text-xs tabular-nums text-[var(--color-ink-muted)]">
                  {formatBytes(Number(file.size))}
                </span>
                {/*
                  * The token travels with the request: this page is anonymous,
                  * so there is no session for the file route to check.
                  */}
                <a
                  href={`/api/share/${token}/files/${file.id}`}
                  className="shrink-0 text-xs text-[var(--color-accent)] hover:underline"
                >
                  Download
                </a>
              </li>
            ))}
          </ul>
        </Card>
      </section>

      <footer className="mt-8 text-xs text-[var(--color-ink-faint)]">
        <p>
          This link shows one model. Whoever shared it can revoke the link at any time.
        </p>
      </footer>
    </main>
  )
}

