'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Loader2, Lock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { updateLibrary } from '../actions'

export interface EditableLibrary {
  id: string
  name: string
  kind: 'in_place' | 'managed'
  backend: 'local' | 's3'
  path: string | null
  prefix: string | null
  connectionId: string | null
  writeSidecar: boolean
  groupingMode: 'deepest' | 'top_level' | 'flat'
}

export interface ConnectionChoice {
  id: string
  name: string
  bucket: string
  endpoint: string | null
  credentials: string
}

const GROUPING: Record<EditableLibrary['groupingMode'], string> = {
  deepest: 'Each folder',
  top_level: 'Top level',
  flat: 'Fixed depth',
}

/**
 * Editing a library.
 *
 * The fixed settings are shown rather than hidden, with the reason, so that
 * "why can't I change the folder?" has an answer on the page. Changing where
 * a library points would make every indexed model look missing; the way to do
 * that is a new library.
 */
export function EditLibraryForm({
  library,
  connections,
}: {
  library: EditableLibrary
  connections: ConnectionChoice[]
}) {
  const router = useRouter()
  const [name, setName] = useState(library.name)
  const [writeSidecar, setWriteSidecar] = useState(library.writeSidecar)
  const [connectionId, setConnectionId] = useState(library.connectionId ?? '')
  const [error, setError] = useState<string | null>(null)
  const [saving, startSaving] = useTransition()

  const selected = connections.find((connection) => connection.id === connectionId)

  function save(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    startSaving(async () => {
      const result = await updateLibrary(library.id, {
        name,
        writeSidecar,
        ...(library.backend === 's3' && { s3ConnectionId: connectionId || null }),
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
    <form onSubmit={save} className="max-w-3xl space-y-4">
      <Card>
        <CardContent className="space-y-4 p-5">
          <Field label="Library name" htmlFor="name">
            <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
          </Field>

          {library.backend === 's3' && (
            <Field
              label="S3 connection"
              htmlFor="s3-connection"
              hint={
                selected
                  ? `Reaches ${selected.bucket} with ${selected.credentials}. Only connections to this library’s bucket are listed.`
                  : 'Choose the connection whose key reaches this library’s bucket.'
              }
            >
              <Select value={connectionId} onChange={(e) => setConnectionId(e.target.value)}>
                {!library.connectionId && (
                  <option value="" disabled>
                    Choose a connection…
                  </option>
                )}
                {connections.map((connection) => (
                  <option key={connection.id} value={connection.id}>
                    {connection.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}

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
                <code className="font-mono text-xs">.printbench.json</code> file, so your metadata
                survives a database loss and moves with the files. Turning it off stops new writes;
                sidecars already written are left where they are.
              </span>
            </span>
          </label>

          {error && (
            <p role="alert" className="text-sm text-[var(--color-danger)]">
              {error}
            </p>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={() => router.push('/admin/libraries')}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || !name.trim()}>
              {saving && <Loader2 className="animate-spin" />}
              {saving ? 'Saving…' : 'Save changes'}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3 p-5">
          <p className="flex items-center gap-2 text-sm font-medium">
            <Lock className="size-4 text-[var(--color-ink-faint)]" />
            Fixed when the library was created
          </p>
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[max-content_1fr]">
            <dt className="text-[var(--color-ink-muted)]">Type</dt>
            <dd>{library.kind === 'managed' ? 'Uploads library' : 'Existing files (read-only)'}</dd>

            {library.backend === 's3' ? (
              <>
                <dt className="text-[var(--color-ink-muted)]">Bucket</dt>
                <dd className="font-mono text-xs leading-5">{selected?.bucket ?? '—'}</dd>
                <dt className="text-[var(--color-ink-muted)]">Prefix</dt>
                <dd className="font-mono text-xs leading-5">{library.prefix ?? 'whole bucket'}</dd>
              </>
            ) : (
              <>
                <dt className="text-[var(--color-ink-muted)]">Folder</dt>
                <dd className="break-all font-mono text-xs leading-5">{library.path}</dd>
              </>
            )}

            <dt className="text-[var(--color-ink-muted)]">Grouping</dt>
            <dd>{GROUPING[library.groupingMode]}</dd>
          </dl>
          <p className="text-xs text-[var(--color-ink-faint)]">
            Every indexed model is recorded relative to this location and grouping, so changing them
            would make the whole library look missing at the next scan. To index somewhere else, add
            a new library.
            {library.backend === 's3' && (
              <>
                {' '}
                To rotate the key for this bucket, edit its connection under{' '}
                <Link href="/admin/storage" className="underline underline-offset-2">
                  Storage
                </Link>
                .
              </>
            )}
          </p>
        </CardContent>
      </Card>
    </form>
  )
}
