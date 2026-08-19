'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, Boxes, Check, FolderSearch, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Field } from '@/components/ui/field'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/cn'
import { createLibrary, previewLibrary, type PreviewResult } from '../actions'

type GroupingMode = 'deepest' | 'top_level' | 'flat'

const MODES: { value: GroupingMode; label: string; description: string }[] = [
  {
    value: 'deepest',
    label: 'Each folder',
    description:
      'Every folder holding model files becomes a model. Right for most collections.',
  },
  {
    value: 'top_level',
    label: 'Top level',
    description:
      'A folder and everything beneath it is one model. Good when a set has variants in sub-folders.',
  },
  {
    value: 'flat',
    label: 'Fixed depth',
    description: 'Only folders at a set depth become models. For rigidly organised libraries.',
  },
]

export function NewLibraryForm() {
  const router = useRouter()

  const [name, setName] = useState('')
  const [path, setPath] = useState('')
  const [mode, setMode] = useState<GroupingMode>('deepest')
  const [depth, setDepth] = useState(1)
  const [writeSidecar, setWriteSidecar] = useState(true)

  const [preview, setPreview] = useState<PreviewResult | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, startSaving] = useTransition()

  async function runPreview(nextMode: GroupingMode = mode, nextDepth: number = depth) {
    if (!path.trim()) {
      setError('Enter a folder path first.')
      return
    }
    setError(null)
    setPreviewing(true)
    try {
      const result = await previewLibrary({
        path,
        groupingMode: nextMode,
        groupingDepth: nextDepth,
      })
      setPreview(result)
      if (!result.ok && result.error) setError(result.error)
      // Seed the name from the folder once we know the path is real.
      if (result.ok && !name.trim()) {
        const folder = path.replace(/[\\/]+$/, '').split(/[\\/]/).pop()
        if (folder) setName(folder)
      }
    } finally {
      setPreviewing(false)
    }
  }

  function changeMode(next: GroupingMode) {
    setMode(next)
    if (preview?.ok) void runPreview(next, depth)
  }

  function save() {
    setError(null)
    startSaving(async () => {
      const result = await createLibrary({
        name,
        path,
        kind: 'in_place',
        groupingMode: mode,
        groupingDepth: mode === 'flat' ? depth : undefined,
        writeSidecar,
      })
      if (!result.ok) {
        setError(result.error)
        return
      }
      router.push('/admin/libraries')
      router.refresh()
    })
  }

  return (
    <div className="max-w-3xl space-y-6">
      <Card>
        <CardContent className="space-y-4 p-5">
          <Field
            label="Folder path"
            htmlFor="path"
            hint="As the server sees it. In Docker this is the path inside the container, e.g. /libraries/prints."
          >
            <Input
              name="path"
              value={path}
              placeholder="/libraries/prints"
              onChange={(e) => setPath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void runPreview()
                }
              }}
              className="font-mono"
            />
          </Field>

          <Button variant="secondary" disabled={previewing} onClick={() => void runPreview()}>
            {previewing ? <Loader2 className="animate-spin" /> : <FolderSearch />}
            {previewing ? 'Looking…' : 'Preview what will be indexed'}
          </Button>

          {error && (
            <p role="alert" className="text-sm text-[var(--color-danger)]">
              {error}
            </p>
          )}
        </CardContent>
      </Card>

      {/*
        The dry run is the point of this screen. The folder-to-model heuristic
        is the riskiest logic in the app, so it gets shown and corrected BEFORE
        anything is written, rather than discovered afterwards.
      */}
      {preview?.ok && (
        <Card>
          <CardContent className="space-y-5 p-5">
            <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
              <p className="text-sm">
                <span className="text-2xl font-semibold tabular-nums">{preview.modelCount}</span>{' '}
                <span className="text-[var(--color-ink-muted)]">models</span>
              </p>
              <p className="text-sm text-[var(--color-ink-muted)]">
                {preview.fileCount} files · {preview.containerCount} folders treated as groups
              </p>
            </div>

            {preview.warnings.map((warning) => (
              <p
                key={warning}
                className="flex items-start gap-2 rounded-[var(--radius-control)] bg-[var(--color-surface-2)] p-3 text-sm text-[var(--color-ink-muted)]"
              >
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-[var(--color-warning)]" />
                {warning}
              </p>
            ))}

            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-[var(--color-ink-faint)]">
                How folders are grouped
              </p>
              <div className="grid gap-2 sm:grid-cols-3">
                {MODES.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => changeMode(option.value)}
                    className={cn(
                      'rounded-[var(--radius-control)] border p-3 text-left transition-colors',
                      mode === option.value
                        ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)]'
                        : 'border-[var(--color-border)] hover:bg-[var(--color-surface-2)]',
                    )}
                  >
                    <span className="flex items-center gap-1.5 text-sm font-medium">
                      {option.label}
                      {mode === option.value && <Check className="size-3.5" />}
                    </span>
                    <span className="mt-1 block text-xs text-[var(--color-ink-muted)]">
                      {option.description}
                    </span>
                  </button>
                ))}
              </div>

              {mode === 'flat' && (
                <div className="mt-3 max-w-40">
                  <Field label="Depth" htmlFor="depth">
                    <Input
                      name="depth"
                      type="number"
                      min={1}
                      max={6}
                      value={depth}
                      onChange={(e) => {
                        const next = Number(e.target.value)
                        setDepth(next)
                        void runPreview(mode, next)
                      }}
                    />
                  </Field>
                </div>
              )}
            </div>

            {preview.samples.length > 0 && (
              <div>
                <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-[var(--color-ink-faint)]">
                  Sample of what would be created
                </p>
                <ul className="divide-y divide-[var(--color-border)] rounded-[var(--radius-control)] border border-[var(--color-border)]">
                  {preview.samples.map((sample) => (
                    <li key={sample.path} className="flex items-center gap-3 px-3 py-2">
                      <Boxes className="size-4 shrink-0 text-[var(--color-ink-faint)]" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{sample.name}</span>
                        <span className="block truncate font-mono text-xs text-[var(--color-ink-faint)]">
                          {sample.path}
                        </span>
                      </span>
                      {sample.isFileModel && <Badge tone="neutral">single file</Badge>}
                      <span className="shrink-0 text-xs tabular-nums text-[var(--color-ink-muted)]">
                        {sample.fileCount} file{sample.fileCount === 1 ? '' : 's'}
                      </span>
                    </li>
                  ))}
                </ul>
                {preview.modelCount > preview.samples.length && (
                  <p className="mt-2 text-xs text-[var(--color-ink-faint)]">
                    …and {preview.modelCount - preview.samples.length} more.
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {preview?.ok && (
        <Card>
          <CardContent className="space-y-4 p-5">
            <Field label="Library name" htmlFor="name">
              <Input name="name" value={name} onChange={(e) => setName(e.target.value)} />
            </Field>

            <label className="flex cursor-pointer items-start gap-3">
              <input
                type="checkbox"
                checked={writeSidecar}
                onChange={(e) => setWriteSidecar(e.target.checked)}
                className="mt-0.5 size-4 accent-[var(--color-accent)]"
              />
              <span className="text-sm">
                <span className="font-medium">Write a metadata sidecar into each model folder</span>
                <span className="mt-0.5 block text-[var(--color-ink-muted)]">
                  Saves tags, creator and notes to a small{' '}
                  <code className="font-mono text-xs">.printmanager.json</code> file, so your
                  metadata survives a database loss and moves with the files. This is the only
                  thing ever written into an indexed folder — your model files are never touched.
                </span>
              </span>
            </label>

            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" onClick={() => router.push('/admin/libraries')}>
                Cancel
              </Button>
              <Button disabled={saving || !name.trim()} onClick={save}>
                {saving ? 'Adding…' : 'Add library'}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
