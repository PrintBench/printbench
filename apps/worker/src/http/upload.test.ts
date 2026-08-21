import { describe, expect, it } from 'vitest'
import { sanitizeUploadPath, signUploadToken, verifyUploadToken } from './upload'

/**
 * The upload path comes from the browser — from a folder drag-and-drop, so it
 * genuinely carries directory structure worth keeping — and is therefore
 * entirely untrusted. It decides where bytes are written, which makes it the
 * highest-consequence input in the application.
 */
describe('sanitizeUploadPath', () => {
  it('accepts an ordinary file', () => {
    expect(sanitizeUploadPath('body.stl')).toBe('body.stl')
  })

  it('preserves folder structure from a directory drop', () => {
    expect(sanitizeUploadPath('Red Dragon/stl/body.stl')).toBe('Red Dragon/stl/body.stl')
  })

  it('normalises Windows separators', () => {
    expect(sanitizeUploadPath('Red Dragon\\stl\\body.stl')).toBe('Red Dragon/stl/body.stl')
  })

  it('keeps unicode and emoji names', () => {
    expect(sanitizeUploadPath('Pokémon Gym/gym.3mf')).toBe('Pokémon Gym/gym.3mf')
    expect(sanitizeUploadPath('dragon 🐉.stl')).toBe('dragon 🐉.stl')
  })

  describe('refuses anything that could escape the library', () => {
    const attacks = [
      '../secrets.stl',
      '../../etc/passwd.stl',
      'a/../../b.stl',
      '/etc/passwd.stl',
      '/absolute/body.stl',
      'C:/Windows/system.stl',
      'C:\\Windows\\system.stl',
      '\\\\server\\share\\body.stl',
      'a/./b.stl',
      '',
      '.',
      '..',
    ]
    for (const attack of attacks) {
      it(JSON.stringify(attack), () => {
        expect(sanitizeUploadPath(attack)).toBeNull()
      })
    }
  })

  it('refuses a path with a NUL byte', () => {
    expect(sanitizeUploadPath('body\0.stl')).toBeNull()
  })

  it('refuses dotfiles, which could shadow our own sidecar', () => {
    expect(sanitizeUploadPath('.printbench.json')).toBeNull()
    expect(sanitizeUploadPath('Red Dragon/.printbench.json')).toBeNull()
    expect(sanitizeUploadPath('.hidden.stl')).toBeNull()
  })

  it('refuses OS rubbish', () => {
    expect(sanitizeUploadPath('Thumbs.db')).toBeNull()
    expect(sanitizeUploadPath('__MACOSX/body.stl')).toBeNull()
    expect(sanitizeUploadPath('Red Dragon/@eaDir/body.stl')).toBeNull()
  })

  it('refuses formats the library would not index', () => {
    // A mystery file the app can neither view, search nor thumbnail is just
    // disk space with no way to get at it.
    expect(sanitizeUploadPath('malware.exe')).toBeNull()
    expect(sanitizeUploadPath('script.sh')).toBeNull()
    expect(sanitizeUploadPath('body.stl.exe')).toBeNull()
  })

  it('accepts every format the library does index', () => {
    for (const name of ['a.stl', 'a.3mf', 'a.obj', 'a.ply', 'a.step', 'a.gcode', 'a.png', 'a.zip']) {
      expect(sanitizeUploadPath(name), name).toBe(name)
    }
  })

  it('refuses implausibly deep or long paths', () => {
    expect(sanitizeUploadPath(Array(20).fill('deep').join('/') + '/a.stl')).toBeNull()
    expect(sanitizeUploadPath('a'.repeat(1200) + '.stl')).toBeNull()
  })
})

describe('upload tokens', () => {
  const SECRET = 'test-secret-at-least-32-characters-long'
  const LIBRARY = '11111111-2222-4333-8444-555555555555'
  const future = () => Date.now() + 60_000

  it('accepts a token it just issued', () => {
    const expires = future()
    expect(verifyUploadToken(LIBRARY, expires, signUploadToken(LIBRARY, expires, SECRET), SECRET))
      .toBe(true)
  })

  it('rejects an expired token', () => {
    const expires = Date.now() - 1000
    expect(verifyUploadToken(LIBRARY, expires, signUploadToken(LIBRARY, expires, SECRET), SECRET))
      .toBe(false)
  })

  /*
   * The token binds the library. Without that, permission to upload to a
   * managed library would become permission to write into any of them.
   */
  it('rejects a token issued for a different library', () => {
    const expires = future()
    const token = signUploadToken(LIBRARY, expires, SECRET)
    expect(verifyUploadToken('99999999-8888-4777-8666-555555555555', expires, token, SECRET))
      .toBe(false)
  })

  it('rejects a tampered expiry', () => {
    const expires = future()
    const token = signUploadToken(LIBRARY, expires, SECRET)
    expect(verifyUploadToken(LIBRARY, expires + 3_600_000, token, SECRET)).toBe(false)
  })

  it('rejects malformed tokens without throwing', () => {
    const expires = future()
    for (const bad of ['', 'nonsense', 'f'.repeat(64)]) {
      expect(() => verifyUploadToken(LIBRARY, expires, bad, SECRET)).not.toThrow()
      expect(verifyUploadToken(LIBRARY, expires, bad, SECRET)).toBe(false)
    }
  })

  it('uses a different signature domain from download tokens', async () => {
    // Prefixed with "upload:", so a download token cannot be replayed here.
    const { signDownloadToken } = await import('./zip')
    const expires = future()
    expect(signUploadToken(LIBRARY, expires, SECRET)).not.toBe(
      signDownloadToken(LIBRARY, expires, SECRET),
    )
  })
})
