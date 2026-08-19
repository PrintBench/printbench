import { describe, expect, it } from 'vitest'
import { contentDisposition, parseRange } from './delivery'

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
