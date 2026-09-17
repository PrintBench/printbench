import { afterEach, describe, expect, it, vi } from 'vitest'
import { withMemoryDiagnostics } from './memory-diagnostics'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('worker memory diagnostics', () => {
  it('does not log or schedule sampling unless enabled', async () => {
    vi.stubEnv('WORKER_MEMORY_LOG', '0')
    const log = vi.spyOn(console, 'info').mockImplementation(() => {})
    const timer = vi.spyOn(globalThis, 'setInterval')
    const handler = vi.fn(async () => {})
    await withMemoryDiagnostics('file.analyze', handler)({ fileId: 'file-id' })
    expect(handler).toHaveBeenCalledWith({ fileId: 'file-id' })
    expect(log).not.toHaveBeenCalled()
    expect(timer).not.toHaveBeenCalled()
  })

  it('identifies the file and stops sampling when the handler fails', async () => {
    vi.stubEnv('WORKER_MEMORY_LOG', '1')
    vi.useFakeTimers()
    const log = vi.spyOn(console, 'info').mockImplementation(() => {})
    const failure = new Error('parse failed')
    const handler = async () => {
      await vi.advanceTimersByTimeAsync(15_000)
      throw failure
    }
    await expect(
      withMemoryDiagnostics('file.analyze', handler)({ fileId: 'file-id' }),
    ).rejects.toBe(failure)
    const entries = log.mock.calls.map((call) => JSON.parse(call[1] as string))
    expect(entries.map((entry) => entry.event)).toEqual(['start', 'sample', 'error'])
    expect(entries[0]).toMatchObject({
      job: 'file.analyze',
      fileId: 'file-id',
      rssMiB: expect.any(Number),
    })
    expect(vi.getTimerCount()).toBe(0)
  })
})
