import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { zipSync } from 'fflate'
import { LocalAdapter } from '@pb/core'
import { extractZipIntoLibrary, ZipIngestError } from './zip-ingest'

/**
 * Extracting an uploaded zip.
 *
 * The entry names here are the attacker's input — nothing about the zip
 * format stops a "file" from being named "../../../etc/cron.d/evil" — so the
 * tests care most about what does NOT end up on disk.
 */

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

describe('extractZipIntoLibrary', () => {
  let base = ''
  let library = ''

  /**
   * A managed local library, which is what an upload target always is. The
   * extractor writes through this rather than touching `fs`, so the same code
   * path serves an S3 bucket — see the MinIO checks in verify-s3.mts.
   */
  const storage = () =>
    new LocalAdapter({
      id: 'zip-fixture',
      kind: 'managed',
      backend: 'local',
      allowWrites: true,
      path: library,
    })

  beforeEach(async () => {
    base = await mkdtemp(path.join(tmpdir(), 'pb-zip-'))
    library = path.join(base, 'library')
    await mkdir(library, { recursive: true })
  })

  afterEach(async () => {
    await rm(base, { recursive: true, force: true })
  })

  async function makeZip(entries: Record<string, string>): Promise<string> {
    const zipped = zipSync(
      Object.fromEntries(Object.entries(entries).map(([name, text]) => [name, bytes(text)])),
    )
    const zipPath = path.join(base, 'upload.zip')
    await writeFile(zipPath, zipped)
    return zipPath
  }

  it('extracts files into the destination folder', async () => {
    const zip = await makeZip({ 'body.stl': 'stl-data', 'images/photo.jpg': 'jpg-data' })

    const result = await extractZipIntoLibrary(zip, storage(), 'Dragon')

    expect(result.filesExtracted).toBe(2)
    expect(await readFile(path.join(library, 'Dragon', 'body.stl'), 'utf8')).toBe('stl-data')
    expect(await readFile(path.join(library, 'Dragon', 'images', 'photo.jpg'), 'utf8')).toBe('jpg-data')
  })

  it('unwraps a single common root folder', async () => {
    // Exactly what a Thingiverse-style download looks like: everything under
    // one folder named after the pack.
    const zip = await makeZip({ 'Dragon/body.stl': 'stl-data', 'Dragon/head.stl': 'more-data' })

    await extractZipIntoLibrary(zip, storage(), 'Dragon')

    expect(await readFile(path.join(library, 'Dragon', 'body.stl'), 'utf8')).toBe('stl-data')
    // NOT nested as Dragon/Dragon/body.stl.
    expect(await pathExists(path.join(library, 'Dragon', 'Dragon'))).toBe(false)
  })

  it('refuses a zip-slip entry rather than writing outside the destination', async () => {
    const zip = await makeZip({
      'body.stl': 'stl-data',
      '../../../../etc/cron.d/evil': 'malicious',
    })

    const result = await extractZipIntoLibrary(zip, storage(), 'Dragon')

    // The safe entry still lands; the traversal attempt is dropped silently.
    expect(result.filesExtracted).toBe(1)
    expect(await pathExists(path.join(base, 'etc'))).toBe(false)

    // Nothing escaped the library root either.
    const outside = await readdir(base)
    expect(outside).not.toContain('etc')
  })

  it('refuses an absolute-path entry the same way', async () => {
    const zip = await makeZip({ 'body.stl': 'stl-data', '/etc/passwd': 'malicious' })

    const result = await extractZipIntoLibrary(zip, storage(), 'Dragon')

    expect(result.filesExtracted).toBe(1)
    expect(await readdir(path.join(library, 'Dragon'))).toEqual(['body.stl'])
  })

  it('ignores macOS zip junk', async () => {
    const zip = await makeZip({
      'body.stl': 'stl-data',
      '__MACOSX/._body.stl': 'resource-fork-junk',
      '.DS_Store': 'finder-junk',
    })

    const result = await extractZipIntoLibrary(zip, storage(), 'Dragon')

    expect(result.filesExtracted).toBe(1)
    expect(await readdir(path.join(library, 'Dragon'))).toEqual(['body.stl'])
  })

  it('refuses to extract into a folder that already exists', async () => {
    const zip = await makeZip({ 'body.stl': 'stl-data' })
    await extractZipIntoLibrary(zip, storage(), 'Dragon')

    const again = await makeZip({ 'other.stl': 'more-data' })
    await expect(extractZipIntoLibrary(again, storage(), 'Dragon')).rejects.toThrow(ZipIngestError)

    // The original extraction is untouched.
    expect(await readdir(path.join(library, 'Dragon'))).toEqual(['body.stl'])
  })

  it('refuses a zip with nothing worth extracting', async () => {
    const zip = await makeZip({ '.DS_Store': 'finder-junk' })
    await expect(extractZipIntoLibrary(zip, storage(), 'Dragon')).rejects.toThrow(ZipIngestError)
    expect(await pathExists(path.join(library, 'Dragon'))).toBe(false)
  })
})

async function pathExists(target: string): Promise<boolean> {
  try {
    await readFile(target)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EISDIR') return true
    return false
  }
}
