import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { LocalAdapter } from '../storage/local-adapter'
import { isIndexable } from '../library/media-types'
import { groupModels } from '../library/grouping'
import { walkLibrary } from '../library/walker'
import {
  LEGACY_SIDECAR_FILENAMES,
  SIDECAR_FILENAME,
  isIgnoredName,
  isSidecarFilename,
} from '../library/paths'
import { readSidecar, serializeSidecar, writeSidecar } from './sidecar'

/**
 * Reading sidecars written before the rename.
 *
 * This application was called Print Manager, and it wrote `.printmanager.json`
 * into people's model folders — carrying tags, creator and notes that exist
 * nowhere else. Renaming the file we write is harmless; forgetting how to read
 * the old one would discard all of that silently at the next scan, which is
 * exactly the loss the sidecar exists to prevent.
 */

const LEGACY = '.printmanager.json'

describe('legacy sidecars', () => {
  let root = ''

  const storage = () =>
    new LocalAdapter({
      id: 'legacy-fixture',
      kind: 'managed',
      backend: 'local',
      allowWrites: true,
      path: root,
    })

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'pb-legacy-'))
    await mkdir(path.join(root, 'Red Dragon'), { recursive: true })
    await writeFile(path.join(root, 'Red Dragon', 'body.stl'), 'x')
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('still recognises the old name', () => {
    expect(LEGACY_SIDECAR_FILENAMES).toContain(LEGACY)
    expect(isSidecarFilename(LEGACY)).toBe(true)
    expect(isSidecarFilename(SIDECAR_FILENAME)).toBe(true)
    expect(isSidecarFilename('.DS_Store')).toBe(false)
  })

  it('does not treat either name as junk to skip', () => {
    // Both start with a dot, which is otherwise an ignore rule.
    expect(isIgnoredName(SIDECAR_FILENAME)).toBe(false)
    expect(isIgnoredName(LEGACY)).toBe(false)
  })

  it('reads metadata out of a file written under the old name', async () => {
    await writeFile(
      path.join(root, 'Red Dragon', LEGACY),
      serializeSidecar({ name: 'Red Dragon', tags: ['dragon'], creator: 'Loot Studios' }),
    )

    const { data } = await readSidecar(storage(), 'Red Dragon')
    expect(data?.creator).toBe('Loot Studios')
    expect(data?.tags).toEqual(['dragon'])
  })

  /*
   * A folder migrates by the new file appearing beside the old one, so both
   * exist for a while. The current name has to win, or an edit made after the
   * rename would be shadowed by whatever the old file still said.
   */
  it('prefers the current name when both are present', async () => {
    await writeFile(
      path.join(root, 'Red Dragon', LEGACY),
      serializeSidecar({ name: 'Stale', creator: 'Old Studio' }),
    )
    await writeFile(
      path.join(root, 'Red Dragon', SIDECAR_FILENAME),
      serializeSidecar({ name: 'Current', creator: 'New Studio' }),
    )

    const { data } = await readSidecar(storage(), 'Red Dragon')
    expect(data?.creator).toBe('New Studio')
  })

  it('writes only the current name, leaving the old file untouched', async () => {
    await writeFile(path.join(root, 'Red Dragon', LEGACY), serializeSidecar({ name: 'Old' }))

    await writeSidecar(storage(), 'Red Dragon', { name: 'Red Dragon', tags: ['moved'] })

    const files = await readdir(path.join(root, 'Red Dragon'))
    expect(files).toContain(SIDECAR_FILENAME)
    // Not deleted: it is the user's file, and this app does not remove those.
    expect(files).toContain(LEGACY)
  })

  /*
   * Grouping is NOT affected by either sidecar name, and that is a
   * pre-existing gap rather than something the rename introduced.
   *
   * `hasSidecar` in grouping.ts intends "a folder holding a sidecar is a
   * model root, stop descending". It can never fire: the walker keeps only
   * files `isIndexable()` accepts, `json` is not in the media-type table, and
   * so a sidecar never reaches the grouping step at all.
   *
   * Pinned here rather than fixed. Making that rule live would change how
   * existing libraries group — the riskiest logic in the application — which
   * is not something to slip into a rename. What matters for the rename is
   * that the metadata is still READ, and that is covered above.
   */
  it('does not affect grouping, under either name (pre-existing)', async () => {
    await mkdir(path.join(root, 'Pack', 'Part A'), { recursive: true })
    await writeFile(path.join(root, 'Pack', 'Part A', 'a.stl'), 'x')
    await writeFile(path.join(root, 'Pack', 'top.stl'), 'x')
    await writeFile(path.join(root, 'Pack', LEGACY), serializeSidecar({ name: 'Pack' }))

    const walk = await walkLibrary(storage(), { mode: 'deep' })
    const grouped = groupModels(walk.tree, { mode: 'deepest' })
    const paths = grouped.models.map((m) => m.path)

    // Both are models: the sidecar did not stop the descent, because the
    // walker filtered it out long before grouping saw it.
    expect(paths).toContain('Pack')
    expect(paths).toContain('Pack/Part A')

    // The reason, asserted directly so this test explains itself if it ever
    // starts failing — which it will, the day a sidecar becomes indexable.
    expect(isIndexable(SIDECAR_FILENAME)).toBe(false)
    expect(isIndexable(LEGACY)).toBe(false)
  })

  it('never counts either sidecar as one of the model files', async () => {
    await writeFile(path.join(root, 'Red Dragon', LEGACY), serializeSidecar({ name: 'X' }))
    await writeFile(
      path.join(root, 'Red Dragon', SIDECAR_FILENAME),
      serializeSidecar({ name: 'X' }),
    )

    const walk = await walkLibrary(storage(), { mode: 'deep' })
    const grouped = groupModels(walk.tree, { mode: 'deepest' })
    const dragon = grouped.models.find((m) => m.path === 'Red Dragon')

    // True by two independent routes: the walker never surfaces them, and
    // collectOwnFiles would skip them anyway.
    expect(dragon?.files.map((f) => f.path)).toEqual(['Red Dragon/body.stl'])
  })

  it('reports a corrupt current sidecar rather than falling back to the old one', async () => {
    // Falling through would hide a real problem behind stale metadata.
    await writeFile(path.join(root, 'Red Dragon', LEGACY), serializeSidecar({ name: 'Old' }))
    await writeFile(path.join(root, 'Red Dragon', SIDECAR_FILENAME), '{ not json')

    const { data, error } = await readSidecar(storage(), 'Red Dragon')
    expect(data).toBeNull()
    expect(error).toBeTruthy()
  })
})
