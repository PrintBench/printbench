'use client'

import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import type { S3Config } from '../actions'

/**
 * The fields for an existing S3 (or S3-compatible) bucket.
 *
 * Only bucket is required. Region and endpoint default sensibly for real AWS;
 * a self-hosted gateway like MinIO needs the endpoint filled in, at which
 * point path-style addressing is switched on automatically since virtual-host
 * addressing needs a wildcard DNS entry per bucket that self-hosted gateways
 * rarely have.
 */
export function S3Fields({
  value,
  onChange,
}: {
  value: S3Config
  onChange: (next: S3Config) => void
}) {
  return (
    <div className="space-y-4">
      <Field label="Bucket" htmlFor="s3-bucket">
        <Input
          name="s3-bucket"
          autoFocus
          value={value.bucket}
          placeholder="my-print-library"
          onChange={(e) => onChange({ ...value, bucket: e.target.value })}
        />
      </Field>

      <Field
        label="Prefix"
        htmlFor="s3-prefix"
        hint="Optional. Only this folder within the bucket is indexed."
      >
        <Input
          name="s3-prefix"
          value={value.prefix ?? ''}
          placeholder="models/"
          onChange={(e) => onChange({ ...value, prefix: e.target.value })}
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Region" htmlFor="s3-region" hint="Leave blank for us-east-1.">
          <Input
            name="s3-region"
            value={value.region ?? ''}
            placeholder="us-east-1"
            onChange={(e) => onChange({ ...value, region: e.target.value })}
          />
        </Field>

        <Field
          label="Endpoint"
          htmlFor="s3-endpoint"
          hint="Only for a self-hosted gateway (MinIO, etc). Leave blank for AWS."
        >
          <Input
            name="s3-endpoint"
            value={value.endpoint ?? ''}
            placeholder="https://minio.example.com"
            onChange={(e) => onChange({ ...value, endpoint: e.target.value })}
          />
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Access key ID"
          htmlFor="s3-access-key"
          hint="Leave blank to use the server's own credentials."
        >
          <Input
            name="s3-access-key"
            value={value.accessKeyId ?? ''}
            onChange={(e) => onChange({ ...value, accessKeyId: e.target.value })}
          />
        </Field>

        <Field label="Secret access key" htmlFor="s3-secret-key">
          <Input
            name="s3-secret-key"
            type="password"
            value={value.secretAccessKey ?? ''}
            onChange={(e) => onChange({ ...value, secretAccessKey: e.target.value })}
          />
        </Field>
      </div>

      <p className="text-xs text-[var(--color-ink-faint)]">
        The secret key is encrypted before it is stored. Downloads are served with a presigned URL,
        so large files go straight from the bucket rather than through this server.
      </p>
    </div>
  )
}
