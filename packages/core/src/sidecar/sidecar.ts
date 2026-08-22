import { z } from 'zod'
import { SIDECAR_FILENAME } from '../library/paths'
import type { StorageAdapter } from '../storage/types'

/**
 * On-disk metadata sidecar.
 *
 * A small JSON file written into each model folder, holding the things the
 * database knows but the filesystem does not: tags, creator, licence, notes,
 * links.
 *
 * The point is that the database becomes rebuildable. Lose Postgres and a
 * rescan restores everything; move the folder to another machine and its
 * metadata travels with it. That is a meaningfully different promise from
 * "take backups", and it costs one small file per model.
 *
 * This is the ONLY thing ever written into an in-place library, and only when
 * the library opts in. Model files themselves are never touched.
 */

export const SIDECAR_VERSION = 1

const sidecarSchema = z.object({
  version: z.number().int().positive(),
  /** Written for humans opening the file; never read back. */
  generator: z.string().optional(),
  updatedAt: z.string().optional(),
  name: z.string().max(500).optional(),
  notes: z.string().max(20_000).nullable().optional(),
  license: z.string().max(120).nullable().optional(),
  creator: z.string().max(225).nullable().optional(),
  tags: z.array(z.string().max(120)).max(200).optional(),
  links: z
    .array(z.object({ url: z.string().max(2000), title: z.string().max(300).optional() }))
    .max(50)
    .optional(),
  /** Model-relative path of the file chosen as the preview. */
  previewFile: z.string().max(1000).nullable().optional(),
})

export type SidecarData = z.infer<typeof sidecarSchema>

export interface SidecarContent {
  name?: string
  notes?: string | null
  license?: string | null
  creator?: string | null
  tags?: string[]
  links?: { url: string; title?: string }[]
  previewFile?: string | null
}

export function sidecarPath(modelPath: string): string {
  return modelPath ? `${modelPath}/${SIDECAR_FILENAME}` : SIDECAR_FILENAME
}

export function serializeSidecar(content: SidecarContent): string {
  const data: SidecarData = {
    version: SIDECAR_VERSION,
    generator: 'printbench',
    updatedAt: new Date().toISOString(),
    ...content,
    // Sorted so rewriting unchanged metadata produces an identical file, which
    // keeps the folder's mtime stable and avoids provoking a rescan.
    tags: content.tags ? [...content.tags].sort((a, b) => a.localeCompare(b)) : undefined,
  }

  // Pretty-printed on purpose: someone will open this in a text editor.
  return `${JSON.stringify(data, null, 2)}\n`
}

/**
 * Parses a sidecar, tolerating anything.
 *
 * A hand-edited or truncated file must never break a scan — it is metadata,
 * not the model. Anything unparseable is reported and ignored.
 */
export function parseSidecar(text: string): { data: SidecarContent | null; error?: string } {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return { data: null, error: error instanceof Error ? error.message : 'Invalid JSON' }
  }

  const parsed = sidecarSchema.safeParse(raw)
  if (!parsed.success) {
    return { data: null, error: parsed.error.issues[0]?.message ?? 'Unexpected shape' }
  }

  if (parsed.data.version > SIDECAR_VERSION) {
    // Written by a newer version of the app. Reading it could silently drop
    // fields, so decline rather than guess.
    return { data: null, error: `Sidecar version ${parsed.data.version} is newer than supported` }
  }

  const {
    version: _version,
    generator: _generator,
    updatedAt: _updatedAt,
    ...content
  } = parsed.data
  return { data: content }
}

/**
 * Reads a model's sidecar.
 *
 * Absent is the normal case: no data, no error. A file that exists but does
 * not parse is reported instead, because treating a corrupt sidecar as absent
 * would look exactly like the metadata having vanished.
 */
export async function readSidecar(
  storage: StorageAdapter,
  modelPath: string,
): Promise<{ data: SidecarContent | null; error?: string }> {
  let text: string
  try {
    const stream = await storage.createReadStream(sidecarPath(modelPath))
    const chunks: Buffer[] = []
    let total = 0
    for await (const chunk of stream) {
      chunks.push(chunk as Buffer)
      total += (chunk as Buffer).length
      // A sidecar is a few kilobytes. Anything larger is not one, and reading
      // it would be a way to make the scanner allocate arbitrarily.
      if (total > 1024 * 1024) {
        return { data: null, error: 'Sidecar is implausibly large; ignoring' }
      }
    }
    text = Buffer.concat(chunks).toString('utf8')
  } catch {
    // Absent is the normal case, not an error.
    return { data: null }
  }

  return parseSidecar(text)
}

export async function writeSidecar(
  storage: StorageAdapter,
  modelPath: string,
  content: SidecarContent,
): Promise<void> {
  await storage.write(sidecarPath(modelPath), serializeSidecar(content))
}

/**
 * True when the sidecar would be unchanged.
 *
 * Checked before writing so untouched metadata does not rewrite the file: a
 * changed mtime makes the containing directory look modified, which sends the
 * next fast scan back through a folder that has not actually changed.
 */
export function sidecarUnchanged(existing: SidecarContent | null, next: SidecarContent): boolean {
  if (!existing) return false
  const normalize = (content: SidecarContent) =>
    JSON.stringify({
      name: content.name ?? null,
      notes: content.notes ?? null,
      license: content.license ?? null,
      creator: content.creator ?? null,
      tags: [...(content.tags ?? [])].sort((a, b) => a.localeCompare(b)),
      links: [...(content.links ?? [])]
        .map((link) => ({ url: link.url, title: link.title ?? null }))
        .sort((a, b) => a.url.localeCompare(b.url)),
      previewFile: content.previewFile ?? null,
    })
  return normalize(existing) === normalize(next)
}
