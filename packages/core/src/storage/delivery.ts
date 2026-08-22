/**
 * HTTP delivery helpers for large files.
 *
 * A print library is full of multi-gigabyte meshes. Pushing those through the
 * Node event loop works, but it is wasteful and makes page rendering stutter
 * while a download is in flight, so in production the bytes are handed to the
 * reverse proxy and Node only performs the authorisation.
 */

export interface ParsedRange {
  start: number
  /** Inclusive, as in HTTP. */
  end: number
  length: number
}

/**
 * Parses a Range header.
 *
 * Only a single range is supported. Multi-range requests are legal but rare,
 * and answering them requires multipart/byteranges — returning the whole entity
 * instead is a permitted and much simpler response.
 *
 * Returns `null` for "no range requested" and `'unsatisfiable'` for a range
 * that cannot be served, which must produce a 416 rather than a 200.
 */
export function parseRange(
  header: string | null,
  size: number,
): ParsedRange | null | 'unsatisfiable' {
  if (!header) return null

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return null

  const [, rawStart, rawEnd] = match
  if (rawStart === '' && rawEnd === '') return 'unsatisfiable'

  let start: number
  let end: number

  if (rawStart === '') {
    // "bytes=-500" means the LAST 500 bytes, not the first 500.
    const suffix = Number(rawEnd)
    if (!Number.isFinite(suffix) || suffix <= 0) return 'unsatisfiable'
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(rawStart)
    end = rawEnd === '' ? size - 1 : Number(rawEnd)
    if (!Number.isFinite(start) || !Number.isFinite(end)) return 'unsatisfiable'
    // A start past the end of the file is unsatisfiable; an end past it is
    // simply clamped, which is what every browser expects.
    if (start >= size) return 'unsatisfiable'
    end = Math.min(end, size - 1)
  }

  if (start > end) return 'unsatisfiable'
  return { start, end, length: end - start + 1 }
}

/**
 * Content-Disposition value that survives non-ASCII filenames.
 *
 * A print library is full of them — "Pokémon Gym.stl", names with emoji. The
 * plain `filename` parameter cannot carry those, so a sanitised ASCII fallback
 * is given alongside the RFC 5987 `filename*` form.
 */
export function contentDisposition(filename: string, disposition: 'inline' | 'attachment'): string {
  const fallback =
    filename
      .normalize('NFKD')
      // Strip combining marks, then anything still outside printable ASCII.
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\x20-\x7e]/g, '_')
      // Quotes and backslashes would terminate or escape the quoted string.
      .replace(/["\\]/g, '_')
      // Collapse runs: a single emoji is a surrogate pair and would otherwise
      // become two underscores.
      .replace(/_{2,}/g, '_')
      .trim() || 'download'

  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}

/** Cache headers for immutable, content-addressed responses. */
export const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable'

/**
 * Cache headers for a file served by its id.
 *
 * Not immutable: the bytes behind a file id can change if the file is edited on
 * disk. Revalidation keeps it correct while still avoiding most transfers.
 */
export const REVALIDATE_CACHE = 'private, max-age=0, must-revalidate'

/**
 * Builds the X-Accel-Redirect path for a file in a library.
 *
 * nginx cannot be told about libraries dynamically, so it exposes one internal
 * location per mounted root and this works out which one applies. The redirect
 * carries the path *relative to that root*, not to the library — a library at
 * `/libraries/prints` and a file at `Dragon/body.stl` must become
 * `/_protected/library/prints/Dragon/body.stl`, or nginx looks for
 * `/libraries/Dragon/body.stl` and answers 404.
 *
 * Returns null when the file is under no known root, which is the signal to
 * fall back to streaming rather than emit a redirect nginx cannot resolve.
 */
export function accelRedirectPath(
  libraryPath: string,
  relativePath: string,
  mounts: { prefix: string; root: string }[],
): string | null {
  const posix = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '')
  const full = `${posix(libraryPath)}/${relativePath.replace(/^\/+/, '')}`

  for (const mount of mounts) {
    const root = posix(mount.root)
    if (full === root) continue

    if (full.startsWith(`${root}/`)) {
      const withinRoot = full.slice(root.length + 1)
      // Re-encoded: a segment may contain spaces or non-ASCII, and nginx wants
      // a URI here rather than a filesystem path.
      return `${mount.prefix}${encodeURI(withinRoot)}`
    }
  }

  return null
}

/**
 * The mounts nginx serves, from configuration.
 *
 * Kept beside the redirect builder so the two cannot drift: adding a mount to
 * nginx.conf without adding it here produces silent 404s on download.
 */
export function accelMounts(): { prefix: string; root: string }[] {
  const configured = process.env.ACCEL_MOUNTS?.trim()

  if (configured) {
    // "prefix=root,prefix=root" — explicit, because the mapping has to match
    // nginx exactly and guessing it is how this breaks.
    return configured
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const [prefix, root] = entry.split('=')
        return { prefix: prefix?.trim() ?? '', root: root?.trim() ?? '' }
      })
      .filter((mount) => mount.prefix && mount.root)
  }

  const dataDir = process.env.DATA_DIR?.trim() || '/data'
  return [
    { prefix: '/_protected/library/', root: '/libraries' },
    { prefix: '/_protected/managed/', root: `${dataDir.replace(/\/+$/, '')}/libraries` },
  ]
}
