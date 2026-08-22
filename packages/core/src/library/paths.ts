/**
 * Path normalisation and ignore rules.
 *
 * Every path that enters the system passes through here, so the rest of the app
 * can assume one canonical form: POSIX separators, NFC-normalised, no leading
 * or trailing slash, relative to a library root.
 *
 * This matters more than it looks. macOS writes filenames in NFD (so "ü" is
 * "u" + combining diaeresis), Linux stores whatever bytes it was given, and
 * Windows uses backslashes and compares case-insensitively. Without a single
 * normalisation point, the same file scanned from two machines produces two
 * different rows.
 */

/** Names that are never files worth indexing, matched case-insensitively. */
const IGNORED_NAMES = new Set([
  'thumbs.db',
  'desktop.ini',
  '.ds_store',
  '.directory',
  'ehthumbs.db',
])

/** Directories that are metadata or rubbish, not model content. */
const IGNORED_DIRS = new Set([
  '__macosx', // macOS zip artefact
  '@eadir', // Synology NAS thumbnails
  '#recycle', // Synology recycle bin
  '$recycle.bin', // Windows recycle bin
  'system volume information',
  '.git',
  'node_modules',
])

const IGNORED_PATTERNS: RegExp[] = [
  /\.tmp$/i,
  /\.temp$/i,
  /\.part$/i,
  /\.crdownload$/i,
  /\.partial$/i,
  /^~\$/, // Office lock files
  /^\.trash/i,
]

/**
 * The sidecar we write.
 *
 * Named here rather than in the sidecar module because the path rules need it:
 * it is a dotfile, and dotfiles are ignored, so it has to be the one exception.
 * Grouping cares as well — a folder holding one is an explicit model root.
 */
export const SIDECAR_FILENAME = '.printbench.json'

export function isSidecarFilename(name: string): boolean {
  return name === SIDECAR_FILENAME
}

/**
 * Converts a native path to the canonical form.
 *
 * NFC rather than NFD because it is the shorter, more widely expected form,
 * and because Postgres comparisons are byte-wise: two spellings of the same
 * name would otherwise be two different rows.
 */
export function normalizePath(input: string): string {
  return input
    .replace(/\\/g, '/')
    .normalize('NFC')
    .replace(/\/+/g, '/')
    .replace(/^\/+|\/+$/g, '')
}

/** Last segment of a path. */
export function basename(path: string): string {
  const normalized = normalizePath(path)
  const slash = normalized.lastIndexOf('/')
  return slash === -1 ? normalized : normalized.slice(slash + 1)
}

/** Everything before the last segment; empty string at the root. */
export function dirname(path: string): string {
  const normalized = normalizePath(path)
  const slash = normalized.lastIndexOf('/')
  return slash === -1 ? '' : normalized.slice(0, slash)
}

export function joinPath(...parts: string[]): string {
  return normalizePath(parts.filter(Boolean).join('/'))
}

/** Path segments, with empties removed. */
export function segments(path: string): string[] {
  const normalized = normalizePath(path)
  return normalized === '' ? [] : normalized.split('/')
}

/** Filename with its extension removed; the whole name if there is none. */
export function stemOf(filename: string): string {
  const base = basename(filename)
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? base : base.slice(0, dot)
}

export function isIgnoredName(name: string): boolean {
  const lower = name.toLowerCase()
  if (IGNORED_NAMES.has(lower)) return true
  if (IGNORED_DIRS.has(lower)) return true
  // Dotfiles and dot-directories, except our own sidecar.
  if (name.startsWith('.') && !isSidecarFilename(name)) return true
  return IGNORED_PATTERNS.some((pattern) => pattern.test(name))
}

/** True when any segment of the path is ignored. */
export function isIgnoredPath(path: string): boolean {
  return segments(path).some((segment) => isIgnoredName(segment))
}

/**
 * Guards against path traversal.
 *
 * A relative path must stay inside its library. Rejects "..", absolute paths,
 * Windows drive letters, UNC prefixes and NUL bytes. This is belt-and-braces
 * next to the realpath check in the storage adapter — both must pass.
 */
export function isSafeRelativePath(path: string): boolean {
  if (path === '') return false
  if (path.includes('\0')) return false

  /*
   * Test the RAW input for absoluteness, not the normalised form.
   * normalizePath strips leading slashes, so "/etc/passwd" would otherwise
   * quietly become the valid relative path "etc/passwd" instead of being
   * rejected.
   */
  const raw = path.replace(/\\/g, '/')
  if (raw.startsWith('/')) return false
  if (/^[a-z]:/i.test(raw)) return false

  const normalized = normalizePath(path)
  if (normalized === '') return false

  return !segments(normalized).some((segment) => segment === '..' || segment === '.')
}

/**
 * A URL- and filesystem-safe slug.
 *
 * Diacritics are folded rather than dropped so "Pokémon" becomes "pokemon"
 * instead of "pokmon".
 */
export function slugify(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
}

/**
 * Turns a folder or file name into a readable model name.
 *
 * Collection folders are habitually named things like
 * "dragon_knight_v2_presupported", which should read as "Dragon Knight V2".
 */
export function humanizeName(input: string): string {
  const withoutExtension = stemOf(input)

  /*
   * A dash with spaces around it is a deliberate separator ("Set A - Variant B")
   * and is kept. A bare hyphen joins words ("calibration-cube") and reads better
   * as a space. Splitting on the real separators first means the blanket hyphen
   * replacement cannot eat them.
   */
  const titled = withoutExtension
    .split(/\s+[-–—]\s+/)
    .map((part) =>
      part
        .replace(/[_+-]+/g, ' ')
        .replace(/(?<=\p{Ll})(?=\p{Lu})/gu, ' ') // camelCase -> camel Case
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter(Boolean)
    .join(' - ')
    /*
     * Title-case only after a real separator.
     *
     * NOT /[a-z]/g: JavaScript word boundaries are ASCII-only, so in a name
     * like "Pokémon" the accented letter reads as a non-word character and
     * the following letter looks like the start of a new word, giving
     * "PokéMon". Any accented name hits this.
     */
    .replace(
      /(^|[\s\-–—/])(\p{Ll})/gu,
      (_, prefix: string, letter: string) => `${prefix}${letter.toUpperCase()}`,
    )

  return titled || withoutExtension
}
