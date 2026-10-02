import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
const mocks = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }))
vi.mock('node:dns/promises', () => ({ lookup: mocks.lookup }))
vi.mock('node:https', () => ({ request: mocks.request }))
import { requestSourceJson, downloadSourceFile, validateSourceRemoteUrl } from './source-network'
const options = { maxBytes: 100, timeoutMs: 1000 }
function serve(responses: { status: number; body: string; headers?: Record<string, string> }[]) {
  mocks.request.mockImplementation((_url, _options, done) => {
    const req = new EventEmitter() as EventEmitter & {
      end: (body?: string) => void
      destroy: (error: Error) => void
    }
    req.end = () => {
      const entry = responses.shift()!
      const response = Object.assign(new PassThrough(), {
        statusCode: entry.status,
        headers: entry.headers ?? {},
      })
      response.once('close', () => req.emit('close'))
      done(response)
      response.end(entry.body)
    }
    req.destroy = (error) => {
      req.emit('error', error)
      req.emit('close')
    }
    return req
  })
}
beforeEach(() => {
  vi.resetAllMocks()
  mocks.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }])
})
afterEach(() => vi.useRealTimers())
describe('external source transport', () => {
  it.each([
    'http://media.printables.com/file.jpg',
    'https://api.printables.com/graphql/other',
    'https://user@media.printables.com/file',
    'https://media.printables.com.evil.test/file',
    'https://media.printables.com:8000/file',
  ])('rejects unsupported Printables destination %s', (url) =>
    expect(() => validateSourceRemoteUrl('printables', url, url.includes('/graphql'))).toThrow(),
  )
  it('allows only Printables GraphQL POST and pins DNS', async () => {
    serve([{ status: 200, body: '{}' }])
    await requestSourceJson('printables', 'https://api.printables.com/graphql', {
      ...options,
      method: 'POST',
      body: '{"query":"query{print(id:1){id}}"}',
    })
    const args = mocks.request.mock.calls[0]!
    expect(args[1].method).toBe('POST')
    expect(args[1].rejectUnauthorized).toBeUndefined()
    const callback = vi.fn()
    args[1].lookup('api.printables.com', { all: true }, callback)
    expect(callback).toHaveBeenCalledWith(null, [{ address: '8.8.8.8', family: 4 }])
  })
  it('rejects mixed public and private DNS results', async () => {
    mocks.lookup.mockResolvedValue([
      { address: '8.8.8.8', family: 4 },
      { address: '10.0.0.1', family: 4 },
    ])
    await expect(
      requestSourceJson('printables', 'https://api.printables.com/graphql', options),
    ).rejects.toThrow('not public')
    expect(mocks.request).not.toHaveBeenCalled()
  })
  it('returns API redirects without following authorization', async () => {
    serve([{ status: 302, body: '', headers: { location: 'https://evil.example/' } }])
    expect(
      (
        await requestSourceJson('thingiverse', 'https://api.thingiverse.com/things/123', {
          ...options,
          headers: { Authorization: 'Bearer private' },
        })
      ).status,
    ).toBe(302)
    expect(mocks.request).toHaveBeenCalledTimes(1)
  })
  it('bounds streaming metadata bodies', async () => {
    serve([{ status: 200, body: 'x'.repeat(101) }])
    await expect(
      requestSourceJson('printables', 'https://api.printables.com/graphql', options),
    ).rejects.toThrow('limits')
  })
  it('bounds a stalled DNS lookup', async () => {
    vi.useFakeTimers()
    mocks.lookup.mockReturnValue(new Promise(() => undefined))
    const pending = expect(
      requestSourceJson('printables', 'https://api.printables.com/graphql', options),
    ).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(1000)
    await pending
    expect(mocks.request).not.toHaveBeenCalled()
  })
  it('follows one fixed Thingiverse download hop while stripping authorization', async () => {
    serve([
      {
        status: 302,
        body: '',
        headers: { location: 'https://cdn.thingiverse.com/assets/model.stl' },
      },
      { status: 200, body: 'model' },
    ])
    const dir = await mkdtemp(join(tmpdir(), 'source-network-'))
    try {
      const destination = join(dir, 'model.stl')
      expect(
        await downloadSourceFile(
          'thingiverse',
          'https://api.thingiverse.com/files/123/download',
          destination,
          { ...options, token: 'private' },
        ),
      ).toBe(5)
      expect(await readFile(destination, 'utf8')).toBe('model')
      expect(mocks.request.mock.calls[0]![1].headers.Authorization).toBe('Bearer private')
      expect(mocks.request.mock.calls[1]![1].headers.Authorization).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
  it('rejects a Thingiverse download redirect to an unknown host', async () => {
    serve([{ status: 302, body: '', headers: { location: 'https://evil.example/collect' } }])
    await expect(
      downloadSourceFile(
        'thingiverse',
        'https://api.thingiverse.com/files/123/download',
        '/tmp/unused-source-test.stl',
        { ...options, token: 'private' },
      ),
    ).rejects.toThrow('not allowed')
    expect(mocks.request).toHaveBeenCalledTimes(1)
  })
  it('refuses a second download redirect', async () => {
    serve([
      { status: 302, body: '', headers: { location: 'https://cdn.thingiverse.com/a.stl' } },
      { status: 302, body: '', headers: { location: 'https://cdn.thingiverse.com/b.stl' } },
    ])
    await expect(
      downloadSourceFile(
        'thingiverse',
        'https://api.thingiverse.com/files/123/download',
        '/tmp/unused-source-test.stl',
        { ...options, token: 'private' },
      ),
    ).rejects.toThrow('refused')
    expect(mocks.request).toHaveBeenCalledTimes(2)
  })
  it('removes a newly created partial file on size overflow', async () => {
    serve([{ status: 200, body: 'x'.repeat(101) }])
    const dir = await mkdtemp(join(tmpdir(), 'source-network-'))
    try {
      const path = join(dir, 'model.stl')
      await expect(
        downloadSourceFile('thingiverse', 'https://cdn.thingiverse.com/model.stl', path, options),
      ).rejects.toThrow('failed')
      await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
