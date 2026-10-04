'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import type { UploadTarget } from './actions'
import { UploadDropzone } from './upload-dropzone'
import { ModelSourceImportForm } from './model-source-import-form'

export function UploadWorkspace({ targets }: { targets: UploadTarget[] }) {
  const [libraryId, setLibraryId] = useState(targets[0]?.id ?? '')
  const [uploadBusy, setUploadBusy] = useState(false)
  const [importBusy, setImportBusy] = useState(false)

  if (targets.length === 0) {
    return (
      <div className="max-w-3xl rounded-[var(--radius-card)] border border-dashed border-[var(--color-border-strong)] p-8 text-center">
        <p className="font-medium">Add a library to get started</p>
        <p className="mt-2 text-sm text-[var(--color-ink-muted)]">
          Uploads and imports need a managed library where PrintBench can save your models.
        </p>
        <Button asChild variant="secondary" className="mt-4">
          <Link href="/admin/libraries/new">Create a managed library</Link>
        </Button>
      </div>
    )
  }

  return (
    <div className="max-w-3xl space-y-5 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 sm:p-6">
      <label className="block text-sm">
        <span className="block pb-2 font-medium">Save to library</span>
        <select
          value={libraryId}
          onChange={(event) => setLibraryId(event.target.value)}
          disabled={uploadBusy || importBusy}
          className="h-10 w-full rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3"
        >
          {targets.map((target) => (
            <option key={target.id} value={target.id}>
              {target.name}
            </option>
          ))}
        </select>
      </label>
      <section aria-label="Upload local files" className="space-y-2">
        <UploadDropzone libraryId={libraryId} onBusyChange={setUploadBusy} />
        <p className="text-xs text-[var(--color-ink-muted)]">
          3MF files can fill in model details. Large uploads resume if your connection drops.
        </p>
      </section>
      <div
        className="flex items-center gap-3 text-xs text-[var(--color-ink-muted)]"
        aria-hidden="true"
      >
        <div className="h-px flex-1 bg-[var(--color-border)]" />
        <span>or paste a model link</span>
        <div className="h-px flex-1 bg-[var(--color-border)]" />
      </div>
      <ModelSourceImportForm libraryId={libraryId} onBusyChange={setImportBusy} />
    </div>
  )
}
