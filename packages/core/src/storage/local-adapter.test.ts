import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, symlink, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { LocalAdapter } from './local-adapter'
import { PathEscapeError, ReadOnlyLibraryError, type LibraryLocation } from './types'
import { walkLibrary } from '../library/walker'
import { groupModels } from '../library/grouping'

/** Files carry size and mtime; most assertions only care about paths. */
const filePaths = (model: { files: { path: string }[] }) => model.files.map((f) => f.path).sort()

let root: string
let outside: string

const inPlace = (): LibraryLocation => ({
  id: 'lib-in-place',
  kind: 'in_place',
  backend: 'local',
  allowWrites: false,
  path: root,
})

const managed = (): LibraryLocation => ({
  id: 'lib-managed',
  kind: 'managed',
  backend: 'local',
  allowWrites: false, // managed libraries are writable regardless of this flag
  path: root,
})

beforeAll(async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'pm-storage-'))
  root = path.join(base, 'library')
  outside = path.join(base, 'outside')

  await mkdir(root, { recursive: true })
  await mkdir(outside, { recursive: true })
  await writeFile(path.join(outside, 'secret.txt'), 'do not read me')

  // A realistic library shape.
  await mkdir(path.join(root, 'Dragons', 'Red Dragon', 'stl'), { recursive: true })
  await mkdir(path.join(root, 'Dragons', 'Red Dragon', 'images'), { recursive: true })
  await mkdir(path.join(root, 'Dragons', 'Blue Dragon'), { recursive: true })
  await mkdir(path.join(root, '__MACOSX'), { recursive: true })

  await writeFile(path.join(root, 'Dragons', 'Red Dragon', 'stl', 'body.stl'), 'x'.repeat(100))
  await writeFile(path.join(root, 'Dragons', 'Red Dragon', 'images', 'render.png'), 'p')
  await writeFile(path.join(root, 'Dragons', 'Red Dragon', 'readme.txt'), 'notes')
  await writeFile(path.join(root, 'Dragons', 'Blue Dragon', 'blue.stl'), 'y'.repeat(50))
  await writeFile(path.join(root, 'benchy.stl'), 'z'.repeat(10))
  await writeFile(path.join(root, 'Thumbs.db'), 'junk')
  await writeFile(path.join(root, '__MACOSX', 'junk.stl'), 'junk')
})

afterAll(async () => {
  await rm(path.dirname(root), { recursive: true, force: true })
})

describe('LocalAdapter containment', () => {
  it('lists the root', async () => {
    const entries = await new LocalAdapter(inPlace()).list('')
    expect(entries.map((e) => e.path).sort()).toContain('benchy.stl')
  })

  it('refuses traversal out of the library', async () => {
    const adapter = new LocalAdapter(inPlace())
    for (const bad of ['../outside/secret.txt', '../../etc/passwd', '/etc/passwd']) {
      await expect(adapter.stat(bad), bad).rejects.toBeInstanceOf(PathEscapeError)
    }
  })

  it('refuses a SYMLINK pointing outside the library', async () => {
    // The case no amount of string checking catches: the path is lexically
    // innocent, and only realpath reveals it leaves the root.
    const linkPath = path.join(root, 'escape-hatch.txt')
    try {
      await symlink(path.join(outside, 'secret.txt'), linkPath)
    } catch {
      return // Windows without developer mode cannot create symlinks; skip.
    }

    const adapter = new LocalAdapter(inPlace())
    await expect(adapter.stat('escape-hatch.txt')).rejects.toBeInstanceOf(PathEscapeError)
    await expect(adapter.createReadStream('escape-hatch.txt')).rejects.toBeInstanceOf(PathEscapeError)
    await rm(linkPath, { force: true })
  })

  it('reads a file inside the library', async () => {
    const stream = await new LocalAdapter(inPlace()).createReadStream('benchy.stl')
    const chunks: Buffer[] = []
    for await (const chunk of stream) chunks.push(chunk as Buffer)
    expect(Buffer.concat(chunks).toString()).toBe('z'.repeat(10))
  })

  it('supports byte ranges, for the viewer and resumable downloads', async () => {
    const stream = await new LocalAdapter(inPlace()).createReadStream('benchy.stl', { start: 2, end: 5 })
    const chunks: Buffer[] = []
    for await (const chunk of stream) chunks.push(chunk as Buffer)
    expect(Buffer.concat(chunks).toString()).toBe('zzzz')
  })
})

describe('read-only enforcement', () => {
  it('refuses to write to an in-place library', async () => {
    const adapter = new LocalAdapter(inPlace())
    await expect(adapter.write('new.stl', 'data')).rejects.toBeInstanceOf(ReadOnlyLibraryError)
  })

  it('refuses to delete from an in-place library', async () => {
    const adapter = new LocalAdapter(inPlace())
    await expect(adapter.remove('benchy.stl')).rejects.toBeInstanceOf(ReadOnlyLibraryError)
    // And the file is still there.
    expect(await adapter.stat('benchy.stl')).not.toBeNull()
  })

  it('allows writes to a managed library', async () => {
    const adapter = new LocalAdapter(managed())
    await adapter.write('managed/created.txt', 'hello')
    expect(await readFile(path.join(root, 'managed', 'created.txt'), 'utf8')).toBe('hello')
    await adapter.remove('managed')
  })

  it('allows writes when explicitly opted in', async () => {
    const adapter = new LocalAdapter({ ...inPlace(), allowWrites: true })
    await adapter.write('opted-in.txt', 'ok')
    await adapter.remove('opted-in.txt')
  })

  it('refuses to write outside the root even when writable', async () => {
    const adapter = new LocalAdapter(managed())
    await expect(adapter.write('../outside/evil.txt', 'x')).rejects.toBeInstanceOf(PathEscapeError)
  })
})

describe('healthCheck', () => {
  it('reports a readable root with its entry count', async () => {
    const result = await new LocalAdapter(inPlace()).healthCheck()
    expect(result.ok).toBe(true)
    expect(result.entryCount).toBeGreaterThan(0)
  })

  it('reports a missing root rather than throwing', async () => {
    const adapter = new LocalAdapter({ ...inPlace(), path: path.join(root, 'nope') })
    const result = await adapter.healthCheck()
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/does not exist/i)
  })
})

describe('walk + group over a real filesystem', () => {
  it('produces the models a human would expect', async () => {
    const { tree, stats } = await walkLibrary(new LocalAdapter(inPlace()))
    const result = groupModels(tree)

    expect(result.models.map((m) => m.path).sort()).toEqual([
      'Dragons/Blue Dragon',
      'Dragons/Red Dragon',
      'benchy.stl',
    ])
    expect(result.containers).toContain('Dragons')

    // Common subfolders were absorbed, junk was skipped.
    const red = result.models.find((m) => m.path === 'Dragons/Red Dragon')!
    expect(filePaths(red)).toEqual([
      'Dragons/Red Dragon/images/render.png',
      'Dragons/Red Dragon/readme.txt',
      'Dragons/Red Dragon/stl/body.stl',
    ])
    expect(stats.errors).toEqual([])
  })

  it('excludes ignored directories and files entirely', async () => {
    const { tree } = await walkLibrary(new LocalAdapter(inPlace()))
    const serialized = JSON.stringify(tree)
    expect(serialized).not.toContain('__MACOSX')
    expect(serialized).not.toContain('Thumbs.db')
  })

  it('records real sizes and mtimes', async () => {
    const { tree } = await walkLibrary(new LocalAdapter(inPlace()))
    const benchy = tree.files.find((f) => f.name === 'benchy.stl')!
    expect(benchy.size).toBe(10)
    expect(benchy.mtimeMs).toBeGreaterThan(0)
  })

  it('fast mode marks unchanged directories and skips re-stat work', async () => {
    const adapter = new LocalAdapter(inPlace())
    const first = await walkLibrary(adapter, { mode: 'deep' })
    expect(first.stats.filesStatted).toBeGreaterThan(0)

    const second = await walkLibrary(adapter, { mode: 'fast', known: first.fingerprints })
    expect(second.stats.dirsUnchanged).toBeGreaterThan(0)
    // Nothing changed, so no file needed re-examining.
    expect(second.stats.filesStatted).toBe(0)
    // Every directory is still visited, and the tree is still complete.
    expect(second.stats.dirsWalked).toBe(first.stats.dirsWalked)
    expect(second.stats.filesSeen).toBe(first.stats.filesSeen)
  })

  /*
   * Regression test for a real design flaw.
   *
   * Adding a file deep in the tree changes only that directory's mtime, never
   * its ancestors'. An earlier version pruned whole subtrees on the parent's
   * fingerprint, so a new file below an unchanged parent was invisible to every
   * future scan.
   */
  it('fast mode finds a new file added deep below an unchanged parent', async () => {
    const adapter = new LocalAdapter(inPlace())
    const baseline = await walkLibrary(adapter, { mode: 'deep' })

    const added = path.join(root, 'Dragons', 'Blue Dragon', 'extra.stl')
    await writeFile(added, 'new')

    const rescan = await walkLibrary(adapter, { mode: 'fast', known: baseline.fingerprints })
    const blue = groupModels(rescan.tree).models.find((m) => m.path === 'Dragons/Blue Dragon')

    expect(blue, 'Blue Dragon should still be found').toBeDefined()
    expect(filePaths(blue!)).toContain('Dragons/Blue Dragon/extra.stl')
    // The parent is genuinely unchanged, which is exactly why pruning it broke.
    expect(rescan.unchangedDirs.has('Dragons')).toBe(true)
    expect(rescan.unchangedDirs.has('Dragons/Blue Dragon')).toBe(false)

    await rm(added, { force: true })
  })

  it('fast mode notices a deleted file', async () => {
    const adapter = new LocalAdapter(inPlace())
    const temp = path.join(root, 'Dragons', 'Blue Dragon', 'temp.stl')
    await writeFile(temp, 'temp')
    const withFile = await walkLibrary(adapter, { mode: 'deep' })

    await rm(temp, { force: true })
    const afterDelete = await walkLibrary(adapter, { mode: 'fast', known: withFile.fingerprints })

    const blue = groupModels(afterDelete.tree).models.find((m) => m.path === 'Dragons/Blue Dragon')!
    expect(filePaths(blue)).not.toContain('Dragons/Blue Dragon/temp.stl')
  })

  it('survives an unreadable subdirectory instead of failing the whole scan', async () => {
    const adapter = new LocalAdapter(inPlace())
    const broken = {
      ...adapter,
      library: adapter.library,
      list: async (dir: string) => {
        if (dir === 'Dragons') throw new Error('EACCES: permission denied')
        return adapter.list(dir)
      },
      stat: adapter.stat.bind(adapter),
    } as unknown as LocalAdapter

    const { tree, stats } = await walkLibrary(broken)
    expect(stats.errors).toHaveLength(1)
    expect(stats.errors[0]!.path).toBe('Dragons')
    // The rest of the library still indexed.
    expect(groupModels(tree).models.map((m) => m.path)).toContain('benchy.stl')
  })
})
