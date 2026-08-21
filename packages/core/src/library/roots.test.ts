import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  RootError,
  browseDirectories,
  isWithinRoots,
  libraryRoots,
  managedRoot,
  validateLibraryPath,
} from './roots'

/**
 * The folder picker's guards.
 *
 * Browsing is admin-only, but "admin" is not "may read every file on the
 * host" — so most of this is about what the picker refuses to show.
 */
describe('library roots', () => {
  let base = ''
  let root = ''
  let outside = ''

  beforeAll(async () => {
    base = await mkdtemp(path.join(tmpdir(), 'pb-roots-'))
    root = path.join(base, 'libraries')
    outside = path.join(base, 'private')

    await mkdir(path.join(root, 'Dragons', 'Red Dragon'), { recursive: true })
    await mkdir(path.join(root, 'Terrain'), { recursive: true })
    await mkdir(path.join(root, '.hidden'), { recursive: true })
    await mkdir(path.join(root, 'Empty Folder'), { recursive: true })
    await mkdir(outside, { recursive: true })

    await writeFile(path.join(root, 'Dragons', 'Red Dragon', 'body.stl'), 'solid\nendsolid\n')
    await writeFile(path.join(root, 'Terrain', 'notes.txt'), 'no models here')
    await writeFile(path.join(outside, 'secrets.txt'), 'private')
  })

  afterAll(async () => {
    await rm(base, { recursive: true, force: true })
  })

  afterEach(() => {
    delete process.env.LIBRARY_ROOTS
    delete process.env.MANAGED_LIBRARY_ROOT
  })

  function withRoot<T>(run: () => T): T {
    process.env.LIBRARY_ROOTS = root
    return run()
  }

  describe('configuration', () => {
    it('reads the configured roots', () => {
      process.env.LIBRARY_ROOTS = root
      expect(libraryRoots()).toEqual([path.resolve(root)])
    })

    it('accepts several, separated the platform way', () => {
      process.env.LIBRARY_ROOTS = [root, outside].join(path.delimiter)
      expect(libraryRoots()).toHaveLength(2)
    })

    it('ignores blank entries', () => {
      process.env.LIBRARY_ROOTS = `${root}${path.delimiter}${path.delimiter}  `
      expect(libraryRoots()).toEqual([path.resolve(root)])
    })

    it('falls back to something usable with nothing configured', () => {
      // A laptop running `npm run dev` has no /libraries and no config.
      const roots = libraryRoots()
      expect(roots.length).toBeGreaterThan(0)

      /*
       * And it should not be the repository itself when a plausible library
       * folder exists beside it: starting the picker in a tree full of
       * node_modules is technically correct and useless.
       */
      expect(roots.some((root) => root.endsWith('node_modules'))).toBe(false)
    })

    it('puts managed libraries somewhere writable, not in the mount', () => {
      process.env.MANAGED_LIBRARY_ROOT = path.join(base, 'uploads')
      expect(managedRoot()).toBe(path.resolve(base, 'uploads'))
    })
  })

  describe('containment', () => {
    it('accepts a folder inside a root', () => {
      withRoot(() => {
        expect(isWithinRoots(path.join(root, 'Dragons'))).toBe(true)
        expect(isWithinRoots(root)).toBe(true)
      })
    })

    it('refuses a folder outside every root', () => {
      withRoot(() => {
        expect(isWithinRoots(outside)).toBe(false)
        expect(isWithinRoots('/etc')).toBe(false)
      })
    })

    it('refuses traversal out of a root', () => {
      withRoot(() => {
        expect(isWithinRoots(path.join(root, '..', 'private'))).toBe(false)
      })
    })

    /*
     * The separator matters. Without it "/libraries-private" counts as inside
     * "/libraries", which is a directory an admin was never offered.
     */
    it('does not treat a sibling with a shared prefix as inside', () => {
      process.env.LIBRARY_ROOTS = root
      expect(isWithinRoots(`${root}-private`)).toBe(false)
    })
  })

  describe('browsing', () => {
    it('lists folders, not files', async () => {
      const result = await withRoot(() => browseDirectories(root))
      const names = result.directories.map((d) => d.name)

      expect(names).toContain('Dragons')
      expect(names).toContain('Terrain')
      expect(names).not.toContain('notes.txt')
    })

    it('hides the folders a scan would ignore anyway', async () => {
      const result = await withRoot(() => browseDirectories(root))
      expect(result.directories.map((d) => d.name)).not.toContain('.hidden')
    })

    // The point of the picker: showing which folders are worth choosing.
    it('marks folders that actually hold models', async () => {
      const result = await withRoot(() => browseDirectories(path.join(root, 'Dragons')))
      expect(result.directories.find((d) => d.name === 'Red Dragon')?.looksLikeModels).toBe(true)
    })

    it('counts entries so an empty folder is visible', async () => {
      const result = await withRoot(() => browseDirectories(root))
      expect(result.directories.find((d) => d.name === 'Empty Folder')?.entryCount).toBe(0)
    })

    it('opens the first root when given nothing', async () => {
      const result = await withRoot(() => browseDirectories())
      expect(result.current).toBe(path.resolve(root))
    })

    /*
     * At a root there must be no way further up, or the picker becomes a
     * filesystem browser for the whole host.
     */
    it('offers no parent at a root', async () => {
      const result = await withRoot(() => browseDirectories(root))
      expect(result.parent).toBeNull()
    })

    it('offers a parent below a root', async () => {
      const result = await withRoot(() => browseDirectories(path.join(root, 'Dragons')))
      expect(result.parent).toBe(path.resolve(root))
    })

    it('refuses to browse outside the roots', async () => {
      await expect(withRoot(() => browseDirectories(outside))).rejects.toThrow(RootError)
    })

    it('refuses a traversal attempt', async () => {
      await expect(
        withRoot(() => browseDirectories(path.join(root, '..', 'private'))),
      ).rejects.toThrow(RootError)
    })

    it('explains a folder that is not there', async () => {
      await expect(
        withRoot(() => browseDirectories(path.join(root, 'no-such-folder'))),
      ).rejects.toThrow(/does not exist/i)
    })
  })

  describe('symlinks', () => {
    it('refuses a link pointing out of the roots', async () => {
      const link = path.join(root, 'escape')
      try {
        await symlink(outside, link, 'dir')
      } catch {
        // Windows without developer mode cannot create these; skip rather
        // than fail on an environment difference.
        return
      }

      process.env.LIBRARY_ROOTS = root
      expect(isWithinRoots(link)).toBe(false)
      await expect(browseDirectories(link)).rejects.toThrow(RootError)

      await rm(link, { force: true })
    })
  })

  describe('validateLibraryPath', () => {
    it('accepts a real folder inside a root', async () => {
      const result = await withRoot(() => validateLibraryPath(path.join(root, 'Terrain')))
      expect(result.ok).toBe(true)
    })

    it('refuses an empty choice', async () => {
      expect(await withRoot(() => validateLibraryPath('  '))).toMatchObject({ ok: false })
    })

    it('names the roots so the error is actionable', async () => {
      const result = await withRoot(() => validateLibraryPath(outside))
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toContain(root)
    })

    it('refuses a file', async () => {
      const result = await withRoot(() =>
        validateLibraryPath(path.join(root, 'Terrain', 'notes.txt')),
      )
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toMatch(/file, not a folder/i)
    })

    it('refuses a folder that does not exist', async () => {
      const result = await withRoot(() => validateLibraryPath(path.join(root, 'nope')))
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toMatch(/does not exist/i)
    })
  })
})
