'use client'

import Link from 'next/link'
import { Cloud } from 'lucide-react'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import type { S3Config } from '../actions'

/** What the picker shows of a connection. Never its credentials. */
export interface ConnectionOption {
  id: string
  name: string
  bucket: string
  endpoint: string | null
}

/**
 * Where an S3 library's files are: a connection, and a prefix within its
 * bucket.
 *
 * The bucket and its credentials are not asked for here. They are set up once
 * under Storage and shared, so a bucket split into several libraries needs its
 * key typed once, and withdrawing it is one change rather than one per library.
 */
export function S3Fields({
  connections,
  value,
  onChange,
}: {
  connections: ConnectionOption[]
  value: S3Config
  onChange: (next: S3Config) => void
}) {
  if (connections.length === 0) {
    return (
      <div className="flex items-start gap-3 rounded-[var(--radius-control)] bg-[var(--color-surface-2)] p-3 text-sm">
        <Cloud className="mt-0.5 size-4 shrink-0 text-[var(--color-ink-faint)]" />
        <p className="text-[var(--color-ink-muted)]">
          There are no S3 connections yet. Add the bucket and its key under{' '}
          <Link
            href="/admin/storage"
            className="font-medium text-[var(--color-ink)] underline decoration-[var(--color-border-strong)] underline-offset-2 hover:decoration-[var(--color-accent)]"
          >
            Storage
          </Link>{' '}
          first, then come back here.
        </p>
      </div>
    )
  }

  const selected = connections.find((connection) => connection.id === value.connectionId)

  return (
    <div className="space-y-4">
      <Field
        label="S3 connection"
        htmlFor="s3-connection"
        hint={
          selected
            ? `Bucket ${selected.bucket}${selected.endpoint ? ` at ${selected.endpoint}` : ''}.`
            : undefined
        }
      >
        <Select
          autoFocus
          value={value.connectionId}
          onChange={(e) => onChange({ ...value, connectionId: e.target.value })}
        >
          <option value="" disabled>
            Choose a connection…
          </option>
          {connections.map((connection) => (
            <option key={connection.id} value={connection.id}>
              {connection.name} ({connection.bucket})
            </option>
          ))}
        </Select>
      </Field>

      <Field
        label="Prefix"
        htmlFor="s3-prefix"
        hint="Optional. Only this folder within the bucket is indexed, so one bucket can hold several libraries."
      >
        <Input
          name="s3-prefix"
          value={value.prefix ?? ''}
          placeholder="models/"
          onChange={(e) => onChange({ ...value, prefix: e.target.value })}
        />
      </Field>

      <p className="text-xs text-[var(--color-ink-faint)]">
        Manage buckets and keys under{' '}
        <Link href="/admin/storage" className="underline underline-offset-2">
          Storage
        </Link>
        . Downloads are served with a presigned URL, so large files go straight from the bucket
        rather than through this server.
      </p>
    </div>
  )
}
