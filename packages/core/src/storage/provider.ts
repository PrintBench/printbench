/**
 * Naming where a library's files are, for people rather than for the adapter.
 *
 * The S3 provider is worked out from the connection's endpoint rather than
 * stored as a separate choice. The endpoint is what every request actually
 * goes to, so a stored "provider" could only ever agree with it or be wrong,
 * and connections created before this existed get a name with no migration.
 *
 * Self-hosted gateways (MinIO, Ceph, Garage) answer on whatever address their
 * owner gave them, so they cannot be named reliably. Rather than guess, those
 * show their host, which is what the admin will recognise anyway.
 */

export interface S3Provider {
  /** Stable identifier; `other` for anything not recognised. */
  id:
    | 'aws'
    | 'backblaze'
    | 'cloudflare-r2'
    | 'wasabi'
    | 'digitalocean'
    | 'google'
    | 'linode'
    | 'scaleway'
    | 'hetzner'
    | 'minio'
    | 'other'
  /** What to show: a vendor's name, or the endpoint's host when unrecognised. */
  name: string
}

/** Host suffixes of hosted services that speak the S3 API. */
const HOSTED: { suffix: string; id: S3Provider['id']; name: string }[] = [
  { suffix: 'amazonaws.com', id: 'aws', name: 'AWS' },
  { suffix: 'backblazeb2.com', id: 'backblaze', name: 'Backblaze B2' },
  { suffix: 'r2.cloudflarestorage.com', id: 'cloudflare-r2', name: 'Cloudflare R2' },
  { suffix: 'wasabisys.com', id: 'wasabi', name: 'Wasabi' },
  { suffix: 'digitaloceanspaces.com', id: 'digitalocean', name: 'DigitalOcean Spaces' },
  { suffix: 'storage.googleapis.com', id: 'google', name: 'Google Cloud Storage' },
  { suffix: 'linodeobjects.com', id: 'linode', name: 'Akamai Object Storage' },
  { suffix: 'scw.cloud', id: 'scaleway', name: 'Scaleway' },
  { suffix: 'your-objectstorage.com', id: 'hetzner', name: 'Hetzner Object Storage' },
]

export function detectS3Provider(endpoint: string | null | undefined): S3Provider {
  const raw = endpoint?.trim() ?? ''
  // No endpoint means the SDK's default: AWS itself.
  if (!raw) return { id: 'aws', name: 'AWS' }

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { id: 'other', name: raw }
  }

  const host = url.hostname.toLowerCase()
  const hosted = HOSTED.find(({ suffix }) => host === suffix || host.endsWith(`.${suffix}`))
  if (hosted) return { id: hosted.id, name: hosted.name }

  /*
   * MinIO has no fixed domain, but it is the gateway this project documents
   * and ships in its dev stack, and is almost always reached as `minio`,
   * `minio.lan`, `minio-01.example.com` and so on.
   */
  if (host.split('.').some((label) => label.startsWith('minio'))) {
    return { id: 'minio', name: 'MinIO' }
  }

  return { id: 'other', name: url.host }
}

/**
 * One short phrase for where a library's files live and what it is for:
 * "Existing folder", "Uploads on this server", or "S3 at <provider>".
 */
export function libraryLocationLabel(library: {
  backend: 'local' | 's3'
  kind: 'in_place' | 'managed'
  /** S3 only: the connection's endpoint, or undefined when it has no connection. */
  s3Endpoint?: string | null
  hasS3Connection?: boolean
}): string {
  if (library.backend === 'local') {
    return library.kind === 'managed' ? 'Uploads on this server' : 'Existing folder'
  }
  if (library.hasS3Connection === false) return 'S3, no connection'
  const provider = detectS3Provider(library.s3Endpoint).name
  return library.kind === 'managed' ? `Uploads to S3 at ${provider}` : `S3 at ${provider}`
}
