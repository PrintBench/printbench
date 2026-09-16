import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { LocalAdapter } from '../storage/local-adapter'
import { isIndexable } from '../library/media-types'
import { groupModels } from '../library/grouping'
import { walkLibrary } from '../library/walker'
import { PACKAGE_SIDECAR_FILENAME, SIDECAR_FILENAME, isIgnoredName } from '../library/paths'
import {
  readPackageSidecar,
  readSidecar,
  serializeSidecar,
  writePackageSidecar,
  writeSidecar,
} from './sidecar'

/**
 * What a sidecar does to grouping, exercised over real files.
 *
 * `hasSidecar` in grouping.ts has always intended "a folder holding a sidecar
 * is a model root, stop descending", and for a long time it could never fire:
 * the walker kept only files `isIndexable()` accepts, `json` is deliberately
 * not in the media-type table, and so a sidecar never reached the grouping
 * step at all. The unit tests in library/grouping.test.ts passed throughout,
 * because they hand grouping a tree directly and never involve the walker.
 * Only a walk over real files shows the gap, which is why the rule is pinned
 * here as well as there.
 */

describe('a sidecar, walked from disk', () => {
  let root = ''

  const storage = () =>
    new LocalAdapter({
      id: 'sidecar-grouping-fixture',
      kind: 'managed',
      backend: 'local',
      allowWrites: true,
      path: root,
    })

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'pb-sidecar-grouping-'))
    await mkdir(path.join(root, 'Red Dragon'), { recursive: true })
    await writeFile(path.join(root, 'Red Dragon', 'body.stl'), 'x')
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('is not treated as junk to skip', () => {
    // It starts with a dot, which is otherwise an ignore rule outright.
    expect(isIgnoredName(SIDECAR_FILENAME)).toBe(false)
    expect(isIgnoredName('.DS_Store')).toBe(true)
  })

  /*
   * How it reaches grouping: as a named exception in the walker, not by making
   * `.json` an indexable extension — that would pull every unrelated JSON file
   * in a library into the index.
   */
  it('is surfaced by the walker without becoming an indexable type', async () => {
    await writeFile(
      path.join(root, 'Red Dragon', SIDECAR_FILENAME),
      serializeSidecar({ name: 'X' }),
    )
    await writeFile(path.join(root, 'Red Dragon', 'notes.json'), '{}')

    const walk = await walkLibrary(storage(), { mode: 'deep' })
    const dragon = walk.tree.dirs.find((d) => d.path === 'Red Dragon')!
    const names = dragon.files.map((f) => f.name)

    expect(names).toContain(SIDECAR_FILENAME)
    expect(names).not.toContain('notes.json')

    expect(isIndexable(SIDECAR_FILENAME)).toBe(false)
    expect(isIndexable('notes.json')).toBe(false)
  })

  it('pins its folder as one model', async () => {
    await mkdir(path.join(root, 'Pack', 'Part A'), { recursive: true })
    await writeFile(path.join(root, 'Pack', 'Part A', 'a.stl'), 'x')
    await writeFile(path.join(root, 'Pack', 'top.stl'), 'x')
    await writeFile(path.join(root, 'Pack', SIDECAR_FILENAME), serializeSidecar({ name: 'Pack' }))

    const walk = await walkLibrary(storage(), { mode: 'deep' })
    const grouped = groupModels(walk.tree, { mode: 'deepest' })
    const paths = grouped.models.map((m) => m.path)

    // One model, not two: the sidecar stopped the descent into Part A.
    expect(paths).toContain('Pack')
    expect(paths).not.toContain('Pack/Part A')

    // And the subfolder's files came WITH it rather than being dropped.
    const pack = grouped.models.find((m) => m.path === 'Pack')!
    expect(pack.files.map((f) => f.path).sort()).toEqual(['Pack/Part A/a.stl', 'Pack/top.stl'])
  })

  it('surfaces a package sidecar and preserves child models', async () => {
    await mkdir(path.join(root, 'Bundle', 'Child'), { recursive: true })
    await writeFile(path.join(root, 'Bundle', 'manual.pdf'), 'manual')
    await writeFile(path.join(root, 'Bundle', 'Child', 'body.stl'), 'mesh')
    await writePackageSidecar(storage(), 'Bundle', { name: 'Bundle' })

    const walk = await walkLibrary(storage(), { mode: 'deep' })
    const grouped = groupModels(walk.tree, { mode: 'deepest' })

    expect(grouped.models.find((model) => model.path === 'Bundle')).toMatchObject({
      isPackage: true,
      files: [expect.objectContaining({ path: 'Bundle/manual.pdf' })],
    })
    expect(grouped.models.find((model) => model.path === 'Bundle/Child')).toMatchObject({
      isPackage: false,
      files: [expect.objectContaining({ path: 'Bundle/Child/body.stl' })],
    })
    expect(
      walk.tree.dirs.find((entry) => entry.path === 'Bundle')?.files.map((file) => file.name),
    ).toContain(PACKAGE_SIDECAR_FILENAME)
  })

  it('is never counted as one of the model files', async () => {
    await writeFile(
      path.join(root, 'Red Dragon', SIDECAR_FILENAME),
      serializeSidecar({ name: 'X' }),
    )

    const walk = await walkLibrary(storage(), { mode: 'deep' })
    const grouped = groupModels(walk.tree, { mode: 'deepest' })
    const dragon = grouped.models.find((m) => m.path === 'Red Dragon')

    // The walker surfaces it so grouping can act on it; `collectOwnFiles` is
    // what keeps it out of the model's file list.
    expect(dragon?.files.map((f) => f.path)).toEqual(['Red Dragon/body.stl'])
  })

  it('round-trips metadata through the storage adapter', async () => {
    await writeSidecar(storage(), 'Red Dragon', {
      name: 'Red Dragon',
      tags: ['dragon'],
      creator: 'Loot Studios',
    })

    expect(await readdir(path.join(root, 'Red Dragon'))).toContain(SIDECAR_FILENAME)

    const { data } = await readSidecar(storage(), 'Red Dragon')
    expect(data?.creator).toBe('Loot Studios')
    expect(data?.tags).toEqual(['dragon'])
  })

  it('round-trips package metadata through its distinct sidecar', async () => {
    await writePackageSidecar(storage(), 'Red Dragon', {
      name: 'Dragon Collection',
      tags: ['bundle'],
    })

    expect(await readdir(path.join(root, 'Red Dragon'))).toContain(PACKAGE_SIDECAR_FILENAME)
    expect((await readPackageSidecar(storage(), 'Red Dragon')).data).toMatchObject({
      name: 'Dragon Collection',
      tags: ['bundle'],
    })
  })

  it('reports a corrupt sidecar rather than reading it as absent', async () => {
    // Silently treating it as missing would look like the metadata vanished.
    await writeFile(path.join(root, 'Red Dragon', SIDECAR_FILENAME), '{ not json')

    const { data, error } = await readSidecar(storage(), 'Red Dragon')
    expect(data).toBeNull()
    expect(error).toBeTruthy()
  })

  it('reads nothing, and reports nothing, where there is no sidecar', async () => {
    const { data, error } = await readSidecar(storage(), 'Red Dragon')
    expect(data).toBeNull()
    expect(error).toBeUndefined()
  })
})
