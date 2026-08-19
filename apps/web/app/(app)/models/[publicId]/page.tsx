import Link from 'next/link'
import { notFound } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { Box, FileStack, FolderOpen, HardDrive, Layers } from 'lucide-react'
import { getDb } from '@pm/db'
import { PageHeader } from '@/components/shell/page-header'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { formatBytes } from '@/components/model/model-card'

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
  library_name: string
  library_path: string
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
           m.file_count, m.total_size, m.is_file_model, m.missing_at,
           l.name AS library_name, l.path AS library_path
    FROM models m JOIN libraries l ON l.id = m.library_id
    WHERE m.public_id = ${publicId} LIMIT 1
  `)

  const model = models.rows[0]
  if (!model) notFound()

  const files = await db.execute<FileRow>(sql`
    SELECT id, filename, extension, category, size, previewable, presupported, missing_at
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
            <Badge tone="neutral">
              <FileStack className="size-3" />
              {model.file_count} files · {formatBytes(Number(model.total_size))}
            </Badge>
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
                      <span className="shrink-0 text-xs tabular-nums text-[var(--color-ink-muted)]">
                        {formatBytes(Number(file.size))}
                      </span>
                    </li>
                  ))}
                </ul>
              </Card>
            </section>
          ))}
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

              {presupportedCount > 0 && (
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-[var(--color-ink-faint)]">
                    Supports
                  </p>
                  <p className="mt-0.5">{presupportedCount} pre-supported files</p>
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
            3D preview, downloads and editing arrive in the next phases.
          </p>
        </aside>
      </div>
    </>
  )
}
