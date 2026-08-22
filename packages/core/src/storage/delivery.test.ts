import { afterEach, describe, expect, it } from 'vitest'
import { accelMounts, accelRedirectPath, contentDisposition, parseRange } from './delivery'

describe('parseRange', () => {
  const SIZE = 1000

  it('returns null when no range was requested', () => {
    expect(parseRange(null, SIZE)).toBeNull()
    expect(parseRange('', SIZE)).toBeNull()
  })

  it('parses a closed range', () => {
    expect(parseRange('bytes=0-499', SIZE)).toEqual({ start: 0, end: 499, length: 500 })
    expect(parseRange('bytes=500-999', SIZE)).toEqual({ start: 500, end: 999, length: 500 })
  })

  it('parses an open-ended range', () => {
    expect(parseRange('bytes=500-', SIZE)).toEqual({ start: 500, end: 999, length: 500 })
  })

  /*
   * "bytes=-500" means the LAST 500 bytes, not the first 500. Reading it as a
   * start offset serves the wrong part of the file, which for a mesh means the
   * viewer silently renders nothing.
   */
  it('parses a suffix range as the final bytes', () => {
    expect(parseRange('bytes=-500', SIZE)).toEqual({ start: 500, end: 999, length: 500 })
    expect(parseRange('bytes=-1', SIZE)).toEqual({ start: 999, end: 999, length: 1 })
  })

  it('clamps a suffix larger than the file', () => {
    expect(parseRange('bytes=-99999', SIZE)).toEqual({ start: 0, end: 999, length: 1000 })
  })

  it('clamps an end past the file rather than failing', () => {
    // Browsers routinely ask for more than exists; clamping is expected.
    expect(parseRange('bytes=900-99999', SIZE)).toEqual({ start: 900, end: 999, length: 100 })
  })

  it('rejects a range that cannot be satisfied', () => {
    expect(parseRange('bytes=1000-', SIZE)).toBe('unsatisfiable')
    expect(parseRange('bytes=5000-6000', SIZE)).toBe('unsatisfiable')
    expect(parseRange('bytes=-', SIZE)).toBe('unsatisfiable')
    expect(parseRange('bytes=-0', SIZE)).toBe('unsatisfiable')
    expect(parseRange('bytes=500-100', SIZE)).toBe('unsatisfiable')
  })

  it('ignores syntax it does not support rather than guessing', () => {
    // Multi-range is legal but rare; answering with the whole entity is allowed.
    expect(parseRange('bytes=0-99,200-299', SIZE)).toBeNull()
    expect(parseRange('items=0-99', SIZE)).toBeNull()
    expect(parseRange('nonsense', SIZE)).toBeNull()
  })

  it('handles a single-byte file', () => {
    expect(parseRange('bytes=0-0', 1)).toEqual({ start: 0, end: 0, length: 1 })
    expect(parseRange('bytes=1-', 1)).toBe('unsatisfiable')
  })
})

describe('contentDisposition', () => {
  it('quotes a plain ASCII name', () => {
    expect(contentDisposition('body.stl', 'attachment')).toBe(
      `attachment; filename="body.stl"; filename*=UTF-8''body.stl`,
    )
  })

  /*
   * Print libraries are full of accented and emoji filenames. The plain
   * `filename` parameter cannot carry those, so a sanitised fallback goes
   * alongside the RFC 5987 encoded form.
   */
  it('gives an ASCII fallback for an accented name', () => {
    const header = contentDisposition('Pokémon Gym.stl', 'attachment')
    expect(header).toContain('filename="Pokemon Gym.stl"')
    expect(header).toContain("filename*=UTF-8''Pok%C3%A9mon%20Gym.stl")
  })

  it('handles emoji and other non-Latin characters', () => {
    const header = contentDisposition('龍 dragon 🐉.stl', 'attachment')
    // Fallback must remain a legal quoted-string.
    expect(/filename="[\x20-\x7e]*"/.test(header)).toBe(true)
    expect(header).toContain('filename*=UTF-8')
  })

  it('neutralises quotes and backslashes that would break the header', () => {
    const header = contentDisposition('a"b\\c.stl', 'attachment')
    const quoted = /filename="([^"]*)"/.exec(header)?.[1] ?? ''
    expect(quoted).not.toContain('"')
    expect(quoted).not.toContain('\\')
  })

  it('never produces an empty fallback', () => {
    expect(contentDisposition('🐉', 'attachment')).toContain('filename="_"')
  })

  it('supports inline disposition for the viewer', () => {
    expect(contentDisposition('body.stl', 'inline').startsWith('inline;')).toBe(true)
  })
})

describe('accelRedirectPath', () => {
  const mounts = [
    { prefix: '/_protected/library/', root: '/libraries' },
    { prefix: '/_protected/managed/', root: '/data/libraries' },
  ]

  /*
   * The bug this exists to prevent: the redirect used to carry the path
   * relative to the LIBRARY, so a library at /libraries/prints asked nginx for
   * /libraries/<file> and every download 404'd in production. It only worked
   * when the library root was exactly the mount.
   */
  it('carries the path relative to the mount, not the library', () => {
    expect(accelRedirectPath('/libraries/prints', 'Dragon/body.stl', mounts)).toBe(
      '/_protected/library/prints/Dragon/body.stl',
    )
  })

  it('still works when the library is the mount itself', () => {
    expect(accelRedirectPath('/libraries', 'Dragon/body.stl', mounts)).toBe(
      '/_protected/library/Dragon/body.stl',
    )
  })

  it('picks the mount that actually contains the file', () => {
    expect(accelRedirectPath('/data/libraries/uploads', 'a.stl', mounts)).toBe(
      '/_protected/managed/uploads/a.stl',
    )
  })

  it('encodes segments that need it', () => {
    const redirect = accelRedirectPath('/libraries', 'Pokémon Gym/body 1.stl', mounts)
    expect(redirect).toContain('%C3%A9')
    expect(redirect).toContain('%20')
  })

  it('tolerates a trailing slash on the library path', () => {
    expect(accelRedirectPath('/libraries/prints/', 'a.stl', mounts)).toBe(
      '/_protected/library/prints/a.stl',
    )
  })

  it('normalises Windows separators, since dev runs there', () => {
    expect(
      accelRedirectPath(String.raw`C:\libs`, 'a.stl', [{ prefix: '/p/', root: 'C:/libs' }]),
    ).toBe('/p/a.stl')
  })

  /*
   * Null rather than a guess: emitting a redirect nginx cannot resolve turns a
   * working stream into a silent 404, so the caller falls back to streaming.
   */
  it('returns null when the file is under no mount', () => {
    expect(accelRedirectPath('/somewhere/else', 'a.stl', mounts)).toBeNull()
  })

  it('does not treat a sibling with a shared prefix as inside a mount', () => {
    expect(accelRedirectPath('/libraries-private', 'a.stl', mounts)).toBeNull()
  })
})

describe('accelMounts', () => {
  afterEach(() => {
    delete process.env.ACCEL_MOUNTS
    delete process.env.DATA_DIR
  })

  it('parses an explicit configuration', () => {
    process.env.ACCEL_MOUNTS = '/a/=/one,/b/=/two'
    expect(accelMounts()).toEqual([
      { prefix: '/a/', root: '/one' },
      { prefix: '/b/', root: '/two' },
    ])
  })

  it('ignores malformed entries rather than producing a broken mount', () => {
    process.env.ACCEL_MOUNTS = '/a/=/one,rubbish,'
    expect(accelMounts()).toEqual([{ prefix: '/a/', root: '/one' }])
  })

  it('defaults to the mounts the shipped compose file provides', () => {
    process.env.DATA_DIR = '/data'
    const roots = accelMounts().map((mount) => mount.root)
    expect(roots).toContain('/libraries')
    expect(roots).toContain('/data/libraries')
  })
})
