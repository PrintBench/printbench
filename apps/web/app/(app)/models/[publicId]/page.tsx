import Link from 'next/link'
import type { Route } from 'next'
import { notFound } from 'next/navigation'
import { headers } from 'next/headers'
import { sql } from 'drizzle-orm'
import { Box, FileStack, FolderOpen, HardDrive, Layers } from 'lucide-react'
import { getDb } from '@pm/db'
import { getSessionUser } from '@pm/auth'
import {
  can,
  canSendToPrinter,
  collectionsForModel,
  getSettings,
  isLiked,
  listCollections,
  listPrints,
  printStats,
  printSuggestions,
  slicersFor,
} from '@pm/core'
import { PageHeader } from '@/components/shell/page-header'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { formatBytes, formatDimensions } from '@/components/model/model-card'
import { ModelViewer } from '@/components/viewer/model-viewer'
import { DownloadModelButton } from './download-button'
import { ModelEditor } from './model-editor'
import { FileDownloadLink } from './file-download-link'
import { OpenInSlicer } from './open-in-slicer'
import { SendToPrinter } from './send-to-printer'
import { PrintHistory } from './print-history'
import { ShareButton } from './share-button'
import { DeleteButton } from './delete-button'
import { LikeButton } from './like-button'
import { CollectionPicker } from './collection-picker'

export const dynamic = 'force-dynamic'

type ModelDetail = {
  id: string
  public_id: string
  name: string
  path: string
  notes: string | null
  license: string | null
  file_count: number
  total_size: string
  is_file_model: boolean
  missing_at: string | null
  share_token: string | null
  library_name: string
  library_path: string
  /** Only a library this app owns may have its files deleted. */
  library_writable: boolean
}

type FileRow = {
  id: string
  filename: string
  extension: string
  category: string
  size: string
  previewable: boolean
  presupported: boolean
  missing_at: string | null
  thumb_state: string
  triangle_count: number | null
  bbox_x: string | null
  bbox_y: string | null
  bbox_z: string | null
}

export async function generateMetadata({ params }: { params: Promise<{ publicId: string }> }) {
  const { publicId } = await params
  const result = await getDb().execute<{ name: string }>(
    sql`SELECT name FROM models WHERE public_id = ${publicId} LIMIT 1`,
  )
  return { title: result.rows[0]?.name ?? 'Model' }
}

export default async function ModelPage({ params }: { params: Promise<{ publicId: string }> }) {
  const { publicId } = await params
  const db = getDb()

  const models = await db.execute<ModelDetail>(sql`
    SELECT m.id, m.public_id, m.name, m.path, m.notes, m.license,
           m.file_count, m.total_size, m.is_file_model, m.missing_at, m.share_token,
           l.name AS library_name, l.path AS library_path,
           (l.kind = 'managed' OR l.allow_writes) AS library_writable
    FROM models m JOIN libraries l ON l.id = m.library_id
    WHERE m.public_id = ${publicId} LIMIT 1
  `)

  const model = models.rows[0]
  if (!model) notFound()

  const files = await db.execute<FileRow>(sql`
    SELECT id, filename, extension, category, size, previewable, presupported, missing_at,
           thumb_state, triangle_count, bbox_x, bbox_y, bbox_z
    FROM model_files WHERE model_id = ${model.id}
    ORDER BY category, filename
  `)

  // Grouping by category makes a 40-file model legible; a flat list does not.
  const byCategory = new Map<string, FileRow[]>()
  for (const file of files.rows) {
    const list = byCategory.get(file.category) ?? []
    list.push(file)
    byCategory.set(file.category, list)
  }

  const CATEGORY_ORDER = ['model', 'image', 'slicer', 'document', 'archive', 'video', 'other']
  const CATEGORY_LABELS: Record<string, string> = {
    model: '3D models',
    image: 'Images',
    slicer: 'Sliced files',
    document: 'Documents',
    archive: 'Archives',
    video: 'Video',
    other: 'Other',
  }

  const presupportedCount = files.rows.filter((f) => f.presupported).length

  const meta = await db.execute<{
    creator: string | null
    creator_id: string | null
    tags: string[] | null
  }>(sql`
    SELECT c.name AS creator, c.id AS creator_id,
           (SELECT array_agg(t.name ORDER BY t.name) FROM model_tags mt
              JOIN tags t ON t.id = mt.tag_id WHERE mt.model_id = m.id) AS tags
    FROM models m LEFT JOIN creators c ON c.id = m.creator_id
    WHERE m.id = ${model.id}
  `)
  const creator = meta.rows[0]?.creator ?? null
  const creatorId = meta.rows[0]?.creator_id ?? null
  const tags = meta.rows[0]?.tags ?? []

  const user = await getSessionUser()
  const policyUser = { id: user?.id ?? '', role: user?.role ?? null }
  const canEdit = can(policyUser, 'model:edit')
  const canLogPrints = can(policyUser, 'print:log')
  const canSend = can(policyUser, 'printhost:send')

  const [prints, stats, suggestions, settings, memberships, liked] = await Promise.all([
    listPrints(db, { modelId: model.id, limit: 50 }),
    printStats(db, model.id),
    printSuggestions(db),
    getSettings(db),
    collectionsForModel(db, model.id),
    user ? isLiked(db, user.id, model.id) : Promise.resolve(false),
  ])

  const canCollect = can(policyUser, 'collection:edit')
  const allCollections = canCollect ? await listCollections(db) : []

  // The largest rendered mesh represents the model, and its dimensions are the
  // ones worth showing — a support-only variant is not what people measure.
  const hero = files.rows
    .filter((f) => f.thumb_state === 'ok' && !f.missing_at)
    .sort((a, b) => Number(b.size) - Number(a.size))[0]

  const heroDimensions = hero
    ? formatDimensions(Number(hero.bbox_x ?? 0), Number(hero.bbox_y ?? 0), Number(hero.bbox_z ?? 0))
    : null

  /*
   * The viewer needs a mesh we can parse in the browser, which is not
   * necessarily the file chosen as the preview — that may well be an image the
   * creator supplied. Largest wins: a support-only variant is rarely the one
   * someone wants to inspect.
   */
  const VIEWABLE = new Set(['stl', '3mf', 'obj', 'ply'])
  const viewable = files.rows
    .filter((f) => !f.missing_at && VIEWABLE.has(f.extension.toLowerCase()))
    .sort((a, b) => Number(b.size) - Number(a.size))[0]

  const NUMBER = new Intl.NumberFormat('en-GB')

  /*
   * Built here rather than in the client component: only the server knows the
   * configured public address, and a link built from window.location would be
   * wrong behind a proxy.
   */
  const requestHeaders = await headers()
  const appOrigin =
    process.env.APP_URL?.replace(/\/+$/, '') ??
    `${requestHeaders.get('x-forwarded-proto') ?? 'http'}://${
      requestHeaders.get('x-forwarded-host') ?? requestHeaders.get('host') ?? 'localhost:3000'
    }`

  return (
    <>
      <nav className="mb-4 flex items-center gap-1.5 text-sm text-[var(--color-ink-muted)]">
        <Link href="/models" className="hover:text-[var(--color-ink)]">
          Models
        </Link>
        <span aria-hidden>/</span>
        <span className="truncate text-[var(--color-ink)]">{model.name}</span>
      </nav>

      <PageHeader
        title={model.name}
        description={model.notes ?? undefined}
        actions={
          model.missing_at ? (
            <Badge tone="danger">Missing from disk</Badge>
          ) : (
            <div className="flex items-center gap-3">
              <Badge tone="neutral">
                <FileStack className="size-3" />
                {model.file_count} files · {formatBytes(Number(model.total_size))}
              </Badge>
              {user && <LikeButton publicId={model.public_id} liked={liked} />}
              {canCollect && (
                <CollectionPicker
                  publicId={model.public_id}
                  collections={allCollections.map((c) => ({ id: c.id, name: c.name }))}
                  memberOf={memberships.map((c) => c.id)}
                />
              )}
              {settings.publicSharing && canEdit && (
                <ShareButton
                  publicId={model.public_id}
                  shared={model.share_token != null}
                  shareUrl={
                    model.share_token ? `${appOrigin}/share/${model.share_token}` : null
                  }
                />
              )}
              {can(policyUser, 'model:delete') && (
                <DeleteButton
                  publicId={model.public_id}
                  name={model.name}
                  libraryName={model.library_name}
                  fileCount={model.file_count}
                  canDeleteFiles={model.library_writable}
                />
              )}
              <ModelEditor
                publicId={model.public_id}
                canEdit={canEdit}
                initial={{
                  name: model.name,
                  notes: model.notes,
                  license: model.license,
                  creator,
                  tags,
                }}
              />
              <DownloadModelButton publicId={model.public_id} />
            </div>
          )
        }
      />

      {model.missing_at && (
        <Card className="mb-6 border-[var(--color-danger)]">
          <CardContent className="p-4 text-sm">
            <p className="font-medium text-[var(--color-danger)]">
              This model was not found during the last scan.
            </p>
            <p className="mt-1 text-[var(--color-ink-muted)]">
              Its record is kept for 30 days in case the folder comes back — nothing has been
              deleted. If the drive is unmounted, remount it and scan again.
            </p>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_260px]">
        <div className="space-y-6">
          {viewable ? (
            <ModelViewer
              fileId={viewable.id}
              format={viewable.extension.toLowerCase() as 'stl' | '3mf' | 'obj' | 'ply'}
              fileSize={Number(viewable.size)}
              filename={viewable.filename.split('/').pop() ?? viewable.filename}
              thumbnailFileId={hero?.id ?? null}
              maxBytes={settings.viewerMaxBytes}
              className="aspect-[16/10]"
            />
          ) : (
            hero && (
              <Card className="overflow-hidden">
                <div className="flex aspect-[16/10] items-center justify-center bg-[var(--color-surface-2)]">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`/api/files/${hero.id}/thumb`}
                    alt={`Render of ${model.name}`}
                    className="size-full object-contain p-4"
                  />
                </div>
              </Card>
            )
          )}

          {CATEGORY_ORDER.filter((category) => byCategory.has(category)).map((category) => (
            <section key={category}>
              <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold">
                {category === 'model' ? <Box className="size-4" /> : <Layers className="size-4" />}
                {CATEGORY_LABELS[category]}
                <span className="font-normal text-[var(--color-ink-faint)]">
                  {byCategory.get(category)!.length}
                </span>
              </h2>

              <Card className="overflow-hidden">
                <ul className="divide-y divide-[var(--color-border)]">
                  {byCategory.get(category)!.map((file) => (
                    <li
                      key={file.id}
                      className={
                        file.missing_at
                          ? 'flex items-center gap-3 px-4 py-2.5 opacity-50'
                          : 'flex items-center gap-3 px-4 py-2.5'
                      }
                    >
                      <span className="w-10 shrink-0 rounded bg-[var(--color-surface-2)] px-1.5 py-0.5 text-center text-[10px] font-medium uppercase text-[var(--color-ink-faint)]">
                        {file.extension || '—'}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-sm" title={file.filename}>
                        {file.filename}
                      </span>
                      {file.presupported && <Badge tone="accent">supported</Badge>}
                      {file.missing_at && <Badge tone="danger">missing</Badge>}
                      {file.triangle_count != null && (
                        <span className="hidden shrink-0 text-xs tabular-nums text-[var(--color-ink-faint)] sm:inline">
                          {NUMBER.format(file.triangle_count)} tris
                        </span>
                      )}
                      <span className="shrink-0 text-xs tabular-nums text-[var(--color-ink-muted)]">
                        {formatBytes(Number(file.size))}
                      </span>
                      {!file.missing_at && (
                        <>
                          {/* Only where a slicer actually reads the format. */}
                          {slicersFor(file.extension).length > 0 && (
                            <OpenInSlicer fileId={file.id} filename={file.filename} />
                          )}
                          {canSend && canSendToPrinter(file.extension) && (
                            <SendToPrinter fileId={file.id} filename={file.filename} />
                          )}
                          <FileDownloadLink fileId={file.id} filename={file.filename} />
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              </Card>
            </section>
          ))}

          <PrintHistory
            publicId={model.public_id}
            canLog={canLogPrints}
            files={files.rows
              .filter((file) => !file.missing_at)
              .map((file) => ({ id: file.id, filename: file.filename }))}
            suggestions={suggestions}
            stats={{
              ...stats,
              lastPrintedAt: stats.lastPrintedAt?.toISOString() ?? null,
            }}
            prints={prints.map((print) => ({
              ...print,
              startedAt: print.startedAt?.toISOString() ?? null,
              finishedAt: print.finishedAt?.toISOString() ?? null,
              createdAt: print.createdAt.toISOString(),
            }))}
          />
        </div>

        <aside className="space-y-4">
          <Card>
            <CardContent className="space-y-3 p-4 text-sm">
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-[var(--color-ink-faint)]">
                  Library
                </p>
                <p className="mt-0.5 flex items-center gap-1.5">
                  <HardDrive className="size-3.5 text-[var(--color-ink-faint)]" />
                  {model.library_name}
                </p>
              </div>

              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-[var(--color-ink-faint)]">
                  Folder
                </p>
                <p className="mt-0.5 flex items-start gap-1.5 break-all font-mono text-xs">
                  <FolderOpen className="mt-0.5 size-3.5 shrink-0 text-[var(--color-ink-faint)]" />
                  {model.path}
                </p>
              </div>

              {heroDimensions && (
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-[var(--color-ink-faint)]">
                    Size
                  </p>
                  <p className="mt-0.5 tabular-nums">{heroDimensions}</p>
                </div>
              )}

              {presupportedCount > 0 && (
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-[var(--color-ink-faint)]">
                    Supports
                  </p>
                  <p className="mt-0.5">{presupportedCount} pre-supported files</p>
                </div>
              )}

              {creator && (
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-[var(--color-ink-faint)]">
                    Creator
                  </p>
                  <Link
                    href={`/search?creator=${encodeURIComponent(creatorId ?? '')}` as Route}
                    className="mt-0.5 block text-[var(--color-accent)] hover:underline"
                  >
                    {creator}
                  </Link>
                </div>
              )}

              {memberships.length > 0 && (
                <div>
                  <p className="mb-1 text-xs font-medium uppercase tracking-wide text-[var(--color-ink-faint)]">
                    Collections
                  </p>
                  <div className="flex flex-wrap gap-1">
                    {memberships.map((collection) => (
                      <Link
                        key={collection.id}
                        href={`/collections/${collection.slug}` as Route}
                        className="rounded-full bg-[var(--color-surface-2)] px-2 py-0.5 text-xs text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
                      >
                        {collection.name}
                      </Link>
                    ))}
                  </div>
                </div>
              )}

              {tags.length > 0 && (
                <div>
                  <p className="mb-1 text-xs font-medium uppercase tracking-wide text-[var(--color-ink-faint)]">
                    Tags
                  </p>
                  <div className="flex flex-wrap gap-1">
                    {tags.map((tag) => (
                      <Link
                        key={tag}
                        href={`/search?q=${encodeURIComponent(tag)}` as Route}
                        className="rounded-full bg-[var(--color-surface-2)] px-2 py-0.5 text-xs text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
                      >
                        {tag}
                      </Link>
                    ))}
                  </div>
                </div>
              )}

              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-[var(--color-ink-faint)]">
                  Licence
                </p>
                <p className="mt-0.5 text-[var(--color-ink-muted)]">
                  {model.license ?? 'Not recorded'}
                </p>
              </div>
            </CardContent>
          </Card>

          <p className="text-xs text-[var(--color-ink-faint)]">
            Drag to rotate, scroll to zoom.
          </p>
        </aside>
      </div>
    </>
  )
}
