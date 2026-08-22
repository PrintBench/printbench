import { describe, expect, it } from 'vitest'
import { groupModels, looksPresupported, pickPreviewFile, type WalkedDir } from './grouping'
import { humanizeName, isIgnoredName, isSafeRelativePath, normalizePath, slugify } from './paths'
import { categoryOf, extensionOf, isPreviewable } from './media-types'

/** Compact tree builder so the fixtures read like the folders they describe. */
function dir(path: string, files: string[] = [], dirs: WalkedDir[] = []): WalkedDir {
  return {
    path,
    files: files.map((name) => ({ name, size: 1024, mtimeMs: 0 })),
    dirs,
  }
}

const names = (result: { models: { name: string }[] }) => result.models.map((m) => m.name).sort()
/** Files now carry size and mtime; most assertions only care about paths. */
const filePaths = (model: { files: { path: string }[] }) => model.files.map((f) => f.path).sort()
const paths = (result: { models: { path: string }[] }) => result.models.map((m) => m.path).sort()

describe('grouping', () => {
  it('treats a folder of meshes as one model', () => {
    const tree = dir('', [], [dir('Red Dragon', ['body.stl', 'wings.stl', 'base.stl'])])
    const result = groupModels(tree)

    expect(result.models).toHaveLength(1)
    expect(result.models[0]).toMatchObject({ path: 'Red Dragon', isFileModel: false })
    expect(filePaths(result.models[0]!)).toHaveLength(3)
  })

  it('absorbs common subfolders into their parent model', () => {
    const tree = dir(
      '',
      [],
      [
        dir(
          'Red Dragon',
          ['readme.txt'],
          [
            dir('Red Dragon/stl', ['body.stl']),
            dir('Red Dragon/presupported', ['body_sup.stl']),
            dir('Red Dragon/images', ['render.png']),
          ],
        ),
      ],
    )
    const result = groupModels(tree)

    expect(result.models).toHaveLength(1)
    expect(result.models[0]!.path).toBe('Red Dragon')
    // Every file from the subfolders belongs to the one model.
    expect(filePaths(result.models[0]!)).toEqual([
      'Red Dragon/images/render.png',
      'Red Dragon/presupported/body_sup.stl',
      'Red Dragon/readme.txt',
      'Red Dragon/stl/body.stl',
    ])
  })

  it('recurses through nested common subfolders', () => {
    const tree = dir(
      '',
      [],
      [dir('Knight', [], [dir('Knight/stl', [], [dir('Knight/stl/presupported', ['a.stl'])])])],
    )
    const result = groupModels(tree)

    expect(result.models).toHaveLength(1)
    expect(filePaths(result.models[0]!)).toEqual(['Knight/stl/presupported/a.stl'])
  })

  it('treats a pack folder as a container, not a model', () => {
    const tree = dir(
      '',
      [],
      [
        dir(
          'Dragons Pack',
          [],
          [
            dir('Dragons Pack/Red Dragon', ['red.stl']),
            dir('Dragons Pack/Blue Dragon', ['blue.stl']),
          ],
        ),
      ],
    )
    const result = groupModels(tree)

    expect(names(result)).toEqual(['Blue Dragon', 'Red Dragon'])
    expect(result.containers).toContain('Dragons Pack')
  })

  it('handles deep container nesting', () => {
    const tree = dir(
      '',
      [],
      [
        dir(
          'Loot Studios',
          [],
          [
            dir(
              'Loot Studios/January 2026',
              [],
              [
                dir('Loot Studios/January 2026/Hero', ['hero.stl']),
                dir('Loot Studios/January 2026/Villain', ['villain.stl']),
              ],
            ),
          ],
        ),
      ],
    )
    const result = groupModels(tree)

    expect(names(result)).toEqual(['Hero', 'Villain'])
    expect(result.containers).toContain('Loot Studios')
    expect(result.containers).toContain('Loot Studios/January 2026')
  })

  it('makes each loose file at the root its own model', () => {
    const tree = dir('', ['benchy.stl', 'calibration-cube.stl', 'notes.txt'])
    const result = groupModels(tree)

    expect(names(result)).toEqual(['Benchy', 'Calibration Cube'])
    expect(result.models.every((m) => m.isFileModel)).toBe(true)
    // A stray text file is not a model.
    expect(paths(result)).toEqual(['benchy.stl', 'calibration-cube.stl'])
  })

  it('ignores rubbish files and directories', () => {
    const tree = dir(
      '',
      [],
      [
        dir(
          'Dragon',
          ['body.stl', 'Thumbs.db', '.DS_Store', 'partial.stl.part'],
          [dir('Dragon/__MACOSX', ['._body.stl']), dir('Dragon/@eaDir', ['thumb.jpg'])],
        ),
      ],
    )
    const result = groupModels(tree)

    expect(result.models).toHaveLength(1)
    expect(filePaths(result.models[0]!)).toEqual(['Dragon/body.stl'])
  })

  describe('ambiguous folders (files AND model subfolders)', () => {
    const tree = () =>
      dir(
        '',
        [],
        [
          dir(
            'Set',
            ['base.stl'],
            [dir('Set/Variant A', ['a.stl']), dir('Set/Variant B', ['b.stl'])],
          ),
        ],
      )

    it('deepest mode splits them and records the nesting', () => {
      const result = groupModels(tree(), { mode: 'deepest' })

      expect(names(result)).toEqual(['Set', 'Variant A', 'Variant B'])
      const parent = result.models.find((m) => m.path === 'Set')!
      // Recorded so the UI can offer a merge and a nested_model problem is raised.
      expect(parent.nestedModelPaths.sort()).toEqual(['Set/Variant A', 'Set/Variant B'])
      expect(filePaths(parent)).toEqual(['Set/base.stl'])
    })

    it('top_level mode keeps the whole subtree as one model', () => {
      const result = groupModels(tree(), { mode: 'top_level' })

      expect(names(result)).toEqual(['Set'])
      expect(filePaths(result.models[0]!)).toEqual([
        'Set/Variant A/a.stl',
        'Set/Variant B/b.stl',
        'Set/base.stl',
      ])
    })
  })

  it('flat mode takes directories at exactly the given depth', () => {
    const tree = dir(
      '',
      [],
      [
        dir(
          'Creator',
          [],
          [
            dir('Creator/Model A', ['a.stl']),
            dir('Creator/Model B', [], [dir('Creator/Model B/stl', ['b.stl'])]),
          ],
        ),
      ],
    )
    const result = groupModels(tree, { mode: 'flat', depth: 1 })

    expect(names(result)).toEqual(['Creator'])
    expect(filePaths(result.models[0]!)).toEqual([
      'Creator/Model A/a.stl',
      'Creator/Model B/stl/b.stl',
    ])
  })

  /*
   * The sidecar rule: an explicit declaration beats every heuristic.
   *
   * These went untested against the walker for a long time and the rule was
   * dead code as a result — the walker dropped sidecars before grouping could
   * see them, because they are not indexable files. The end-to-end half of
   * this lives in sidecar/sidecar-grouping.test.ts; what is pinned here is
   * what the rule does once a sidecar does arrive.
   */
  describe('an explicit sidecar', () => {
    it('marks a model root regardless of shape', () => {
      const tree = dir(
        '',
        [],
        [dir('Explicit', ['.printbench.json', 'top.stl'], [dir('Explicit/Sub', ['sub.stl'])])],
      )
      const result = groupModels(tree)

      // Without the sidecar this would split into two models.
      expect(names(result)).toEqual(['Explicit'])
      // The subtree collapses INTO the model rather than being discarded:
      // stopping the descent without taking the files below would leave
      // sub.stl belonging to no model at all.
      expect(filePaths(result.models[0]!)).toEqual(['Explicit/Sub/sub.stl', 'Explicit/top.stl'])
    })

    /*
     * The case the rule exists for. A pack folder has no files of its own, so
     * every heuristic reads it as a container and splits it into one model per
     * subfolder. A sidecar at the top is how the user says otherwise.
     */
    it('collapses a container and everything under it into one model', () => {
      const tree = dir(
        '',
        [],
        [
          dir(
            'Goblin Warband',
            ['.printbench.json'],
            [
              dir(
                'Goblin Warband/Archer',
                ['archer.stl'],
                [dir('Goblin Warband/Archer/stl', ['archer_hd.stl'])],
              ),
              dir('Goblin Warband/Chief', ['chief.stl']),
            ],
          ),
        ],
      )
      const result = groupModels(tree)

      expect(paths(result)).toEqual(['Goblin Warband'])
      expect(filePaths(result.models[0]!)).toEqual([
        'Goblin Warband/Archer/archer.stl',
        'Goblin Warband/Archer/stl/archer_hd.stl',
        'Goblin Warband/Chief/chief.stl',
      ])
      // One model, so nothing below it is a container or a nested model.
      expect(result.containers).toEqual([])
      expect(result.models[0]!.nestedModelPaths).toEqual([])
    })

    it('is never itself one of the model files', () => {
      const tree = dir('', [], [dir('Dragon', ['.printbench.json', 'body.stl'])])
      const result = groupModels(tree)

      expect(filePaths(result.models[0]!)).toEqual(['Dragon/body.stl'])
    })

    /*
     * The library root is not a model, so a sidecar sitting there cannot make
     * it one — it would swallow the entire library into a single row.
     */
    it('does not turn the library root into a model', () => {
      const tree = dir(
        '',
        ['.printbench.json'],
        [dir('Red Dragon', ['red.stl']), dir('Blue Dragon', ['blue.stl'])],
      )
      const result = groupModels(tree)

      expect(paths(result)).toEqual(['Blue Dragon', 'Red Dragon'])
    })

    it('pins a folder inside a pack without disturbing its siblings', () => {
      const tree = dir(
        '',
        [],
        [
          dir(
            'Pack',
            [],
            [
              dir(
                'Pack/Kit',
                ['.printbench.json'],
                [dir('Pack/Kit/Piece A', ['a.stl']), dir('Pack/Kit/Piece B', ['b.stl'])],
              ),
              dir('Pack/Loose Model', ['loose.stl']),
            ],
          ),
        ],
      )
      const result = groupModels(tree)

      expect(paths(result)).toEqual(['Pack/Kit', 'Pack/Loose Model'])
      expect(filePaths(result.models.find((m) => m.path === 'Pack/Kit')!)).toEqual([
        'Pack/Kit/Piece A/a.stl',
        'Pack/Kit/Piece B/b.stl',
      ])
      expect(result.containers).toContain('Pack')
    })

    it('wins over every grouping mode', () => {
      const tree = () =>
        dir(
          '',
          [],
          [dir('Set', ['.printbench.json', 'base.stl'], [dir('Set/Variant A', ['a.stl'])])],
        )

      for (const mode of ['deepest', 'top_level', 'flat'] as const) {
        const result = groupModels(tree(), { mode, depth: 2 })
        expect(paths(result), mode).toEqual(['Set'])
        expect(filePaths(result.models[0]!), mode).toEqual(['Set/Variant A/a.stl', 'Set/base.stl'])
      }
    })
  })

  it('skips folders with no model files at all', () => {
    const tree = dir('', [], [dir('Just Photos', ['a.png', 'b.png'])])
    const result = groupModels(tree)
    // Images alone do not make a model.
    expect(result.models).toHaveLength(0)
  })

  it('copes with unicode, emoji and awkward names', () => {
    const tree = dir(
      '',
      [],
      [dir('Pokémon 🐉 Collection', ['pikachu.stl']), dir("Bob's Bits & Bobs", ['thing.stl'])],
    )
    const result = groupModels(tree)

    expect(result.models).toHaveLength(2)
    expect(paths(result)).toEqual(["Bob's Bits & Bobs", 'Pokémon 🐉 Collection'])
  })

  it('is deterministic across repeated runs', () => {
    const tree = dir(
      '',
      ['loose.stl'],
      [dir('A', ['a.stl']), dir('B', [], [dir('B/C', ['c.stl'])])],
    )
    expect(JSON.stringify(groupModels(tree))).toBe(JSON.stringify(groupModels(tree)))
  })

  it('returns nothing for an empty library', () => {
    expect(groupModels(dir(''))).toEqual({ models: [], containers: [] })
  })
})

describe('looksPresupported', () => {
  it('detects the usual conventions', () => {
    for (const path of [
      'Dragon/presupported/body.stl',
      'Dragon/pre-supported/body.stl',
      'Dragon/body_presup.stl',
      'Dragon/supported/body.stl',
      'Dragon/body_sup.stl',
      'Dragon/body wsupports.stl',
      'Dragon/PRESUPPORTED/body.stl',
    ]) {
      expect(looksPresupported(path), path).toBe(true)
    }
  })

  it('does not fire on unsupported or unrelated names', () => {
    for (const path of ['Dragon/body.stl', 'Dragon/supper-club.stl', 'Dragon/sculpture.stl']) {
      expect(looksPresupported(path), path).toBe(false)
    }
  })
})

describe('pickPreviewFile', () => {
  const file = (path: string, category: string, previewable = false, size = 100) => ({
    path,
    size,
    category,
    previewable,
  })

  it('prefers an image named like a cover', () => {
    const chosen = pickPreviewFile(
      [
        file('m/body.stl', 'model', true),
        file('m/preview.png', 'image'),
        file('m/other.png', 'image'),
      ],
      'Dragon',
    )
    expect(chosen).toBe('m/preview.png')
  })

  it('prefers an image named after the model', () => {
    const chosen = pickPreviewFile(
      [file('m/red-dragon.png', 'image'), file('m/z.png', 'image')],
      'Red Dragon',
    )
    expect(chosen).toBe('m/red-dragon.png')
  })

  it('falls back to an image in an images folder', () => {
    const chosen = pickPreviewFile(
      [file('m/images/shot.png', 'image'), file('m/body.stl', 'model', true)],
      'Dragon',
    )
    expect(chosen).toBe('m/images/shot.png')
  })

  it('falls back to the largest previewable mesh', () => {
    const chosen = pickPreviewFile(
      [file('m/small.stl', 'model', true, 10), file('m/big.stl', 'model', true, 999)],
      'Dragon',
    )
    expect(chosen).toBe('m/big.stl')
  })

  it('returns nothing when there is nothing to show', () => {
    expect(pickPreviewFile([file('m/notes.txt', 'document')], 'Dragon')).toBeUndefined()
  })
})

describe('paths', () => {
  it('normalises separators, duplicates and edges', () => {
    expect(normalizePath('a\\b\\c')).toBe('a/b/c')
    expect(normalizePath('/a//b/')).toBe('a/b')
    expect(normalizePath('')).toBe('')
  })

  it('normalises unicode to NFC so one file is one row', () => {
    const nfd = 'Poke\u0301mon/a.stl' // decomposed
    const nfc = 'Pok\u00e9mon/a.stl' // composed
    expect(normalizePath(nfd)).toBe(normalizePath(nfc))
  })

  it('rejects traversal and absolute paths', () => {
    for (const bad of [
      '../etc/passwd',
      'a/../../b',
      '/etc/passwd',
      'C:/Windows',
      'a\0b',
      '',
      './a',
    ]) {
      expect(isSafeRelativePath(bad), bad).toBe(false)
    }
    for (const good of ['a/b.stl', 'Red Dragon/stl/body.stl', 'Pokémon/a.stl']) {
      expect(isSafeRelativePath(good), good).toBe(true)
    }
  })

  it('identifies rubbish to skip', () => {
    for (const name of [
      'Thumbs.db',
      '.DS_Store',
      '__MACOSX',
      '@eaDir',
      'x.tmp',
      '~$doc.docx',
      '.git',
    ]) {
      expect(isIgnoredName(name), name).toBe(true)
    }
    for (const name of ['body.stl', 'readme.txt', '.printbench.json']) {
      expect(isIgnoredName(name), name).toBe(false)
    }
  })

  it('folds diacritics when slugifying rather than dropping them', () => {
    expect(slugify('Pokémon Collection')).toBe('pokemon-collection')
    expect(slugify('Bob’s Bits & Bobs')).toBe('bob-s-bits-bobs')
  })

  it('humanises folder names', () => {
    expect(humanizeName('dragon_knight_v2')).toBe('Dragon Knight V2')
    expect(humanizeName('redDragon')).toBe('Red Dragon')
    expect(humanizeName('benchy.stl')).toBe('Benchy')
    // A bare hyphen joins words; a spaced dash is a real separator.
    expect(humanizeName('calibration-cube')).toBe('Calibration Cube')
    expect(humanizeName('Set A - Variant B')).toBe('Set A - Variant B')
  })

  /*
   * Regression: JavaScript word boundaries are ASCII-only, so an earlier
   * implementation using /[a-z]/g turned "Pokémon" into "PokéMon" — the
   * accented letter read as a non-word character, making the next letter look
   * like the start of a new word. Every accented name was affected.
   */
  it('does not mangle accented names when title-casing', () => {
    expect(humanizeName('Pokémon Gym')).toBe('Pokémon Gym')
    expect(humanizeName('café-noir')).toBe('Café Noir')
    expect(humanizeName('pokémon')).toBe('Pokémon')
  })
})

describe('media types', () => {
  it('extracts extensions, treating dotfiles as extensionless', () => {
    expect(extensionOf('a/b/body.STL')).toBe('stl')
    expect(extensionOf('.gitignore')).toBe('')
    expect(extensionOf('noext')).toBe('')
  })

  it('categorises the formats that matter', () => {
    expect(categoryOf('a.stl')).toBe('model')
    expect(categoryOf('a.3mf')).toBe('model')
    expect(categoryOf('a.step')).toBe('model')
    expect(categoryOf('a.png')).toBe('image')
    expect(categoryOf('a.gcode')).toBe('slicer')
    expect(categoryOf('a.zip')).toBe('archive')
    expect(categoryOf('a.xyz')).toBe('other')
  })

  it('marks only formats we can parse as previewable', () => {
    expect(isPreviewable('a.stl')).toBe(true)
    expect(isPreviewable('a.3mf')).toBe(true)
    // Stored and downloadable, but we will not drag in a CAD kernel to render it.
    expect(isPreviewable('a.step')).toBe(false)
    expect(isPreviewable('a.fbx')).toBe(false)
  })
})
