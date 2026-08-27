'use client'

import { useCallback, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import * as tus from 'tus-js-client'
import { CheckCircle2, FolderUp, TriangleAlert, Upload, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/cn'
import { createUploadTicket, type UploadTarget } from './actions'

/**
 * Resumable uploads, via tus.
 *
 * Resumability is the point. A single miniature can be hundreds of megabytes
 * and a pack can be gigabytes; losing all of it to a dropped connection at 90%
 * is the difference between a feature people use and one they avoid. tus
 * resumes from the last confirmed byte, including across a page reload.
 *
 * Folder drag-and-drop preserves the directory structure, because that
 * structure is exactly what the scanner uses to group files into models — a
 * flattened upload of "Dragon/stl/body.stl" would become an unrelated loose
 * file.
 */

type Status = 'queued' | 'uploading' | 'done' | 'failed'

interface Item {
  id: string
  file: File
  /** Path within the drop, so folder structure survives. */
  relativePath: string
  progress: number
  status: Status
  error?: string
  upload?: tus.Upload
}

/** Formats the same way the rest of the app does. */
function formatSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB']
  const exponent = Math.min(Math.floor(Math.log(Math.max(bytes, 1)) / Math.log(1024)), 3)
  return `${(bytes / 1024 ** exponent).toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`
}

export function UploadDropzone({ targets }: { targets: UploadTarget[] }) {
  const router = useRouter()
  const [libraryId, setLibraryId] = useState(targets[0]?.id ?? '')
  const [items, setItems] = useState<Item[]>([])
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const folderRef = useRef<HTMLInputElement>(null)

  const add = useCallback((files: { file: File; relativePath: string }[]) => {
    setItems((current) => [
      ...current,
      ...files.map(({ file, relativePath }) => ({
        id: `${relativePath}:${file.size}:${file.lastModified}`,
        file,
        relativePath,
        progress: 0,
        status: 'queued' as Status,
      })),
    ])
  }, [])

  const update = useCallback((id: string, patch: Partial<Item>) => {
    setItems((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)))
  }, [])

  async function start() {
    if (!libraryId) {
      setError('Choose a library first.')
      return
    }
    setError(null)

    const ticket = await createUploadTicket(libraryId)
    if (!ticket.ok) {
      setError(ticket.error)
      return
    }

    for (const item of items) {
      if (item.status === 'done' || item.status === 'uploading') continue

      const upload = new tus.Upload(item.file, {
        endpoint: ticket.endpoint,
        // Five megabytes: small enough that a dropped connection loses little,
        // large enough that per-chunk overhead stays negligible on a big file.
        chunkSize: 5 * 1024 * 1024,
        retryDelays: [0, 1000, 3000, 5000, 10_000],
        metadata: {
          libraryId,
          relativePath: item.relativePath,
          filename: item.file.name,
        },
        // Lets tus resume this exact file after a reload instead of restarting.
        storeFingerprintForResuming: true,
        removeFingerprintOnSuccess: true,
        fingerprint: async (file) =>
          [
            'printbench-upload-v2',
            window.location.protocol,
            window.location.host,
            libraryId,
            file.name,
            file.type,
            file.size,
            file.lastModified,
            item.relativePath,
          ].join('|'),
        onError: (uploadError) => {
          update(item.id, { status: 'failed', error: uploadError.message })
        },
        onProgress: (sent, total) => {
          update(item.id, { status: 'uploading', progress: total > 0 ? sent / total : 0 })
        },
        onSuccess: () => {
          update(item.id, { status: 'done', progress: 1 })
          // The worker queues a scan on completion, so the model appears on its
          // own; refresh so the library counts catch up.
          router.refresh()
        },
      })

      update(item.id, { status: 'uploading', upload })
      upload.start()
    }
  }

  function cancel(item: Item) {
    void item.upload?.abort()
    setItems((current) => current.filter((entry) => entry.id !== item.id))
  }

  /**
   * Reads a drop, walking directories when the browser exposes them.
   *
   * webkitGetAsEntry is non-standard but universally supported, and it is the
   * only way to get the folder structure out of a drag-and-drop.
   */
  async function onDrop(event: React.DragEvent) {
    event.preventDefault()
    setDragging(false)

    const entries = [...event.dataTransfer.items]
      .map((item) => item.webkitGetAsEntry?.())
      .filter((entry): entry is FileSystemEntry => entry != null)

    if (entries.length === 0) {
      add([...event.dataTransfer.files].map((file) => ({ file, relativePath: file.name })))
      return
    }

    const collected: { file: File; relativePath: string }[] = []
    await Promise.all(entries.map((entry) => walkEntry(entry, '', collected)))
    add(collected)
  }

  const pending = items.filter((item) => item.status !== 'done')
  const totalBytes = items.reduce((sum, item) => sum + item.file.size, 0)

  if (targets.length === 0) {
    return (
      <div className="rounded-[var(--radius-card)] border border-dashed border-[var(--color-border-strong)] p-8 text-center">
        <FolderUp className="mx-auto mb-3 size-6 text-[var(--color-ink-faint)]" />
        <p className="text-sm font-medium">No library can accept uploads</p>
        <p className="mx-auto mt-1 max-w-md text-sm text-[var(--color-ink-muted)]">
          Uploads go into a <strong>managed</strong> library, which PrintBench owns and organises.
          Your existing folders stay read-only so nothing is ever written into them.
        </p>
        <Button asChild className="mt-4" variant="secondary">
          <a href="/admin/libraries/new">Create a managed library</a>
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {targets.length > 1 && (
        <label className="flex items-center gap-2 text-sm">
          Upload to
          <select
            value={libraryId}
            onChange={(event) => setLibraryId(event.target.value)}
            className="h-9 rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-sm"
          >
            {targets.map((target) => (
              <option key={target.id} value={target.id}>
                {target.name}
              </option>
            ))}
          </select>
        </label>
      )}

      <div
        onDragOver={(event) => {
          event.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => void onDrop(event)}
        className={cn(
          'rounded-[var(--radius-card)] border-2 border-dashed p-10 text-center transition-colors',
          dragging
            ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)]'
            : 'border-[var(--color-border-strong)]',
        )}
      >
        <Upload className="mx-auto mb-3 size-7 text-[var(--color-ink-faint)]" />
        <p className="text-sm font-medium">Drop files or folders here</p>
        <p className="mt-1 text-sm text-[var(--color-ink-muted)]">
          Folder structure is kept, so a model with its own stl and images folders stays together. A
          .zip is extracted rather than stored whole, so a downloaded pack unpacks straight into its
          own folder.
        </p>

        <div className="mt-4 flex justify-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => inputRef.current?.click()}>
            Choose files
          </Button>
          <Button variant="secondary" size="sm" onClick={() => folderRef.current?.click()}>
            <FolderUp />
            Choose a folder
          </Button>
        </div>

        <input
          ref={inputRef}
          type="file"
          multiple
          hidden
          onChange={(event) =>
            add([...(event.target.files ?? [])].map((file) => ({ file, relativePath: file.name })))
          }
        />
        <input
          ref={folderRef}
          type="file"
          multiple
          hidden
          // Non-standard but universally supported; the only way to pick a whole
          // folder and keep its structure.
          {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
          onChange={(event) =>
            add(
              [...(event.target.files ?? [])].map((file) => ({
                file,
                relativePath:
                  (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
              })),
            )
          }
        />
      </div>

      {error && (
        <p role="alert" className="text-sm text-[var(--color-danger)]">
          {error}
        </p>
      )}

      {items.length > 0 && (
        <>
          <div className="flex items-center justify-between">
            <p className="text-sm text-[var(--color-ink-muted)]">
              {items.length} file{items.length === 1 ? '' : 's'} · {formatSize(totalBytes)}
            </p>
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" onClick={() => setItems([])}>
                Clear
              </Button>
              <Button size="sm" disabled={pending.length === 0} onClick={() => void start()}>
                <Upload />
                Upload {pending.length > 0 ? pending.length : ''}
              </Button>
            </div>
          </div>

          <ul className="divide-y divide-[var(--color-border)] overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-border)]">
            {items.map((item) => (
              <li key={item.id} className="flex items-center gap-3 px-3 py-2">
                <span className="w-5 shrink-0">
                  {item.status === 'done' && (
                    <CheckCircle2 className="size-4 text-[var(--color-success)]" />
                  )}
                  {item.status === 'failed' && (
                    <TriangleAlert className="size-4 text-[var(--color-danger)]" />
                  )}
                </span>

                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm" title={item.relativePath}>
                    {item.relativePath}
                  </span>
                  {item.status === 'uploading' && (
                    <span className="mt-1 block h-1 w-full overflow-hidden rounded-full bg-[var(--color-surface-2)]">
                      <span
                        className="block h-full bg-[var(--color-accent)] transition-[width]"
                        style={{ width: `${Math.round(item.progress * 100)}%` }}
                      />
                    </span>
                  )}
                  {item.error && (
                    <span className="block text-xs text-[var(--color-danger)]">{item.error}</span>
                  )}
                </span>

                <span className="shrink-0 text-xs tabular-nums text-[var(--color-ink-muted)]">
                  {item.status === 'uploading'
                    ? `${Math.round(item.progress * 100)}%`
                    : formatSize(item.file.size)}
                </span>

                {item.status !== 'done' && (
                  <button
                    type="button"
                    onClick={() => cancel(item)}
                    aria-label={`Remove ${item.relativePath}`}
                    className="shrink-0 text-[var(--color-ink-faint)] hover:text-[var(--color-ink)]"
                  >
                    <X className="size-4" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

/** Recursively reads a dropped directory entry. */
async function walkEntry(
  entry: FileSystemEntry,
  prefix: string,
  out: { file: File; relativePath: string }[],
): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) =>
      (entry as FileSystemFileEntry).file(resolve, reject),
    )
    out.push({ file, relativePath: prefix ? `${prefix}/${entry.name}` : entry.name })
    return
  }

  if (!entry.isDirectory) return
  const reader = (entry as FileSystemDirectoryEntry).createReader()
  const nested = prefix ? `${prefix}/${entry.name}` : entry.name

  /*
   * readEntries returns at most 100 entries per call and signals the end with
   * an empty batch. Reading once silently truncates any folder with more than
   * a hundred files, which a model pack very often has.
   */
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
      reader.readEntries(resolve, reject),
    )
    if (batch.length === 0) break
    await Promise.all(batch.map((child) => walkEntry(child, nested, out)))
  }
}
