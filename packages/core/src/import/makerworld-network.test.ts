import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

const mocks = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }))
vi.mock('node:dns/promises', () => ({ lookup: mocks.lookup }))
vi.mock('node:https', () => ({ request: mocks.request }))
import { requestMakerWorldJson } from './makerworld-network'

const options = { maxBytes: 100, timeoutMs: 1000, headers: { Authorization: 'Bearer private' } }
function serve(status: number, body: string, headers: Record<string, string> = {}) {
  mocks.request.mockImplementation((_url, _options, done) => {
    const req = new EventEmitter() as EventEmitter & {
      end: () => void
      destroy: (error: Error) => void
    }
    req.end = () => {
      const response = Object.assign(new PassThrough(), { statusCode: status, headers })
      response.once('close', () => req.emit('close'))
      done(response)
      response.end(body)
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

describe('MakerWorld transport boundary', () => {
  it('pins the validated DNS answer in the socket and keeps normal TLS hostname verification', async () => {
    serve(200, '{}')
    await requestMakerWorldJson('https://api.bambulab.com/v1/design-service/design/123', options)
    const args = mocks.request.mock.calls[0]!
    expect(args[0].hostname).toBe('api.bambulab.com')
    expect(args[1].rejectUnauthorized).toBeUndefined()
    const callback = vi.fn()
    args[1].lookup('api.bambulab.com', { all: true }, callback)
    expect(callback).toHaveBeenCalledWith(null, [{ address: '8.8.8.8', family: 4 }])
    expect(mocks.lookup).toHaveBeenCalledTimes(1)
  })

  it('refuses mixed public/private DNS results without opening a socket', async () => {
    mocks.lookup.mockResolvedValue([
      { address: '8.8.8.8', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ])
    await expect(requestMakerWorldJson('https://api.bambulab.com/path', options)).rejects.toThrow(
      'not public',
    )
    expect(mocks.request).not.toHaveBeenCalled()
  })

  it('never follows redirects carrying an Authorization header', async () => {
    serve(302, '', { location: 'https://attacker.example/collect' })
    expect((await requestMakerWorldJson('https://api.bambulab.com/path', options)).status).toBe(302)
    expect(mocks.request).toHaveBeenCalledTimes(1)
  })

  it('enforces actual body size even without Content-Length', async () => {
    serve(200, 'x'.repeat(101))
    await expect(requestMakerWorldJson('https://api.bambulab.com/path', options)).rejects.toThrow(
      'limits',
    )
  })

  it('rejects declared oversized content before consuming the response', async () => {
    serve(200, '', { 'content-length': '101' })
    await expect(requestMakerWorldJson('https://api.bambulab.com/path', options)).rejects.toThrow(
      'size limit',
    )
  })

  it('bounds a stalled DNS lookup', async () => {
    vi.useFakeTimers()
    mocks.lookup.mockReturnValue(new Promise(() => undefined))
    const pending = expect(
      requestMakerWorldJson('https://api.bambulab.com/path', options),
    ).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(1000)
    await pending
    expect(mocks.request).not.toHaveBeenCalled()
  })
})
