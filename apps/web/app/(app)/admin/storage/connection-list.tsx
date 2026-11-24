'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { AlertTriangle, Cloud, FolderPlus, Loader2, Pencil, Plus, Trash2 } from 'lucide-react'
import type { S3ConnectionInput, S3ConnectionSummary } from '@pb/core'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Field } from '@/components/ui/field'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/empty-state'
import { createConnection, deleteConnection, updateConnection } from './actions'

export function ConnectionList({ connections }: { connections: S3ConnectionSummary[] }) {
  const router = useRouter()
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<S3ConnectionSummary | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [pending, startTransition] = useTransition()

  function remove(connection: S3ConnectionSummary) {
    if (!confirm(`Remove the connection “${connection.name}”? Nothing in the bucket is touched.`)) {
      return
    }
    startTransition(async () => {
      const result = await deleteConnection(connection.id)
      setErrors((current) => {
        const next = { ...current }
        if (result.ok) delete next[connection.id]
        else next[connection.id] = result.error
        return next
      })
      router.refresh()
    })
  }

  return (
    <div className="space-y-4">
      {!adding && !editing && (
        <Button size="sm" onClick={() => setAdding(true)}>
          <Plus />
          Add an S3 connection
        </Button>
      )}

      {(adding || editing) && (
        <Card>
          <CardContent className="p-4">
            <ConnectionForm
              key={editing?.id ?? 'new'}
              connection={editing}
              onDone={() => {
                setAdding(false)
                setEditing(null)
                router.refresh()
              }}
              onCancel={() => {
                setAdding(false)
                setEditing(null)
              }}
            />
          </CardContent>
        </Card>
      )}

      {connections.length === 0 && !adding ? (
        <EmptyState
          icon={<Cloud className="size-6" />}
          title="No S3 connections yet"
          description="Add a bucket and its key here, then create libraries on it from Libraries. AWS S3, MinIO, Backblaze B2, Cloudflare R2 and anything else speaking the S3 API all work."
        />
      ) : (
        <div className="grid gap-3">
          {connections.map((connection) => (
            <Card key={connection.id} className="min-w-0">
              <CardContent className="flex flex-wrap items-start gap-3 p-4">
                <Cloud className="mt-0.5 size-4 shrink-0 text-[var(--color-ink-faint)]" />

                <div className="min-w-0 flex-1 basis-48">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    {connection.name}
                    {connection.accessKeyId ? (
                      <Badge tone="neutral">key stored</Badge>
                    ) : (
                      <Badge tone="neutral">server credentials</Badge>
                    )}
                  </p>
                  <p className="truncate font-mono text-xs text-[var(--color-ink-muted)]">
                    {connection.bucket}
                    {connection.endpoint ? ` · ${connection.endpoint}` : ''}
                    {connection.region ? ` · ${connection.region}` : ''}
                  </p>

                  {connection.secretUnreadable && (
                    <p className="mt-1 flex items-start gap-1.5 text-xs text-[var(--color-danger)]">
                      <AlertTriangle className="mt-px size-3 shrink-0" />
                      The stored secret can no longer be read, because BETTER_AUTH_SECRET has
                      changed. Edit the connection and enter the secret again.
                    </p>
                  )}

                  <p className="mt-2 text-xs text-[var(--color-ink-faint)]">
                    {connection.libraries.length === 0 ? (
                      'Not used by any library yet.'
                    ) : (
                      <>
                        Used by{' '}
                        {connection.libraries.map((library, index) => (
                          <span key={library.id}>
                            {index > 0 && ', '}
                            <Link
                              href={`/admin/libraries/${library.id}`}
                              className="text-[var(--color-ink-muted)] underline decoration-[var(--color-border-strong)] underline-offset-2 hover:decoration-[var(--color-accent)]"
                            >
                              {library.name}
                            </Link>
                            <span className="font-mono"> ({library.prefix ?? 'whole bucket'})</span>
                          </span>
                        ))}
                      </>
                    )}
                  </p>

                  {errors[connection.id] && (
                    <p role="alert" className="mt-2 text-sm text-[var(--color-danger)]">
                      {errors[connection.id]}
                    </p>
                  )}
                </div>

                <div className="flex shrink-0 gap-1">
                  <Button variant="ghost" size="sm" asChild>
                    <Link href={`/admin/libraries/new?connection=${connection.id}`}>
                      <FolderPlus />
                      Add library
                    </Link>
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Edit ${connection.name}`}
                    onClick={() => {
                      setEditing(connection)
                      setAdding(false)
                    }}
                  >
                    <Pencil />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove ${connection.name}`}
                    disabled={pending}
                    onClick={() => remove(connection)}
                  >
                    <Trash2 />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * Adding or changing a connection.
 *
 * The stored secret is never sent to the browser, so on an edit a blank secret
 * means "keep what is stored" — otherwise renaming a connection would wipe its
 * key. Clearing the access key ID is how a connection is switched over to the
 * server's own credentials, and that removes the secret with it.
 */
function ConnectionForm({
  connection,
  onDone,
  onCancel,
}: {
  connection: S3ConnectionSummary | null
  onDone: () => void
  onCancel: () => void
}) {
  const [value, setValue] = useState<S3ConnectionInput>({
    name: connection?.name ?? '',
    bucket: connection?.bucket ?? '',
    endpoint: connection?.endpoint ?? '',
    region: connection?.region ?? '',
    accessKeyId: connection?.accessKeyId ?? '',
    secretAccessKey: '',
  })
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const inUse = (connection?.libraries.length ?? 0) > 0
  const keyChanged = (value.accessKeyId ?? '') !== (connection?.accessKeyId ?? '')
  const keepsSecret = Boolean(connection?.hasSecret && value.accessKeyId && !keyChanged)

  function set<K extends keyof S3ConnectionInput>(key: K, next: S3ConnectionInput[K]) {
    setValue((current) => ({ ...current, [key]: next }))
    setError(null)
  }

  function submit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    startTransition(async () => {
      const result = connection
        ? await updateConnection(connection.id, value)
        : await createConnection(value)
      if (!result.ok) setError(result.error)
      else onDone()
    })
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" htmlFor="s3-name" hint="Shown when choosing storage for a library.">
          <Input
            autoFocus
            value={value.name}
            placeholder="Workshop bucket"
            onChange={(e) => set('name', e.target.value)}
          />
        </Field>

        <Field
          label="Bucket"
          htmlFor="s3-bucket"
          hint={
            inUse
              ? 'Fixed while libraries use this connection. Their files are in this bucket.'
              : undefined
          }
        >
          <Input
            value={value.bucket}
            placeholder="my-print-library"
            disabled={inUse}
            onChange={(e) => set('bucket', e.target.value)}
          />
        </Field>

        <Field label="Region" htmlFor="s3-region" hint="Leave blank for us-east-1.">
          <Input
            value={value.region ?? ''}
            placeholder="us-east-1"
            onChange={(e) => set('region', e.target.value)}
          />
        </Field>

        <Field
          label="Endpoint"
          htmlFor="s3-endpoint"
          hint="Only for a self-hosted or non-AWS service (MinIO, R2, B2). Leave blank for AWS."
        >
          <Input
            value={value.endpoint ?? ''}
            placeholder="https://minio.example.com"
            autoComplete="off"
            onChange={(e) => set('endpoint', e.target.value)}
          />
        </Field>

        <Field
          label="Access key ID"
          htmlFor="s3-access-key"
          hint="Leave blank to use the server’s own credentials (an instance role, say)."
        >
          <Input
            value={value.accessKeyId ?? ''}
            autoComplete="off"
            onChange={(e) => set('accessKeyId', e.target.value)}
          />
        </Field>

        <Field
          label="Secret access key"
          htmlFor="s3-secret-key"
          hint={
            keepsSecret
              ? 'Leave blank to keep the stored secret.'
              : connection && keyChanged && value.accessKeyId
                ? 'Required for a new access key.'
                : undefined
          }
        >
          <Input
            type="password"
            value={value.secretAccessKey ?? ''}
            autoComplete="new-password"
            disabled={!value.accessKeyId}
            placeholder={keepsSecret ? '••••••••' : ''}
            onChange={(e) => set('secretAccessKey', e.target.value)}
          />
        </Field>
      </div>

      <p className="text-xs text-[var(--color-ink-faint)]">
        The secret is encrypted before it is stored and never shown again.{' '}
        {inUse
          ? `Saving checks that every library on this connection (${connection!.libraries.length}) can still be read with these settings. Nothing changes if one cannot.`
          : 'Saving checks that the bucket answers with these settings.'}
      </p>

      {error && (
        <p role="alert" className="text-sm text-[var(--color-danger)]">
          {error}
        </p>
      )}

      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {pending && <Loader2 className="animate-spin" />}
          {pending ? 'Checking…' : connection ? 'Save' : 'Add connection'}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
      </div>
    </form>
  )
}
