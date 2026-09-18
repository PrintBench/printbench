import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { collectBounded } from './collect-bounded'
import { analyzeMesh, renderThumbnail } from '../render/thumbnail'
import { MAX_3MF_BYTES } from './threemf'

describe('bounded mesh input', () => {
  it('applies the early limit to both analysis and thumbnail jobs', async () => {
    const source = vi.fn(async () => Readable.from([Buffer.alloc(1)]))
    const options = { byteLength: MAX_3MF_BYTES + 1 }
    await expect(analyzeMesh('3mf', source, options)).rejects.toThrow('memory budget')
    await expect(renderThumbnail('3mf', source, options)).rejects.toThrow('memory budget')
    expect(source).not.toHaveBeenCalled()
  })
  it('rejects a known oversized file without opening storage', async () => {
    const source = vi.fn(async () => Readable.from([Buffer.alloc(1)]))
    await expect(collectBounded(source, 4, '3mf', { byteLength: 5 })).rejects.toThrow(
      'memory budget',
    )
    expect(source).not.toHaveBeenCalled()
  })

  it('enforces streamed bytes even when the database size is stale', async () => {
    let closed = false
    async function* chunks() {
      try {
        yield Buffer.alloc(3)
        yield Buffer.alloc(3)
        yield Buffer.alloc(3)
      } finally {
        closed = true
      }
    }
    const stream = Readable.from(chunks())
    const ended = new Promise<void>((resolve) => stream.on('close', resolve))
    await expect(collectBounded(() => stream, 4, '3mf', { byteLength: 1 })).rejects.toThrow(
      'memory budget',
    )
    await ended
    expect(closed).toBe(true)
    expect(stream.destroyed).toBe(true)
  })

  it('accepts an input exactly at the limit', async () => {
    const result = await collectBounded(
      () => Readable.from([Buffer.from('ab'), Buffer.from('cd')]),
      4,
      '3mf',
    )
    expect(result.toString()).toBe('abcd')
  })

  it('honors cancellation before opening storage', async () => {
    const source = vi.fn(async () => Readable.from([]))
    await expect(
      collectBounded(source, 4, '3mf', { signal: AbortSignal.abort() }),
    ).rejects.toThrow()
    expect(source).not.toHaveBeenCalled()
  })
})
