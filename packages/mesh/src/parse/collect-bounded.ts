import { MeshParseError, type MeshFormat, type StreamSource } from '../types'

/** Check known size before opening, and enforce actual bytes while reading. */
export async function collectBounded(
  source: StreamSource,
  maxBytes: number,
  format: MeshFormat,
  options: { byteLength?: number; signal?: AbortSignal } = {},
): Promise<Buffer> {
  const tooLarge = () =>
    new MeshParseError(
      `${format.toUpperCase()} exceeds the ${Math.round(maxBytes / 1024 / 1024)} MB input memory budget`,
      format,
    )
  options.signal?.throwIfAborted()
  if (options.byteLength !== undefined && options.byteLength > maxBytes) throw tooLarge()
  const chunks: Buffer[] = []
  let total = 0
  // Breaking/throwing from this loop closes the stream, including remote reads.
  for await (const chunk of await source()) {
    options.signal?.throwIfAborted()
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += bytes.byteLength
    if (total > maxBytes) throw tooLarge()
    chunks.push(bytes)
  }
  return Buffer.concat(chunks, total)
}
