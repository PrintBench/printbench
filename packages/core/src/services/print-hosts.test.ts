import { describe, expect, it, vi } from 'vitest'
import {
  canSendToPrinter,
  isValidEndpoint,
  probeHost,
  sendToPrinter,
  type PrintHostConfig,
} from './print-hosts'
import {
  CONVERTIBLE_TO_3MF,
  SLICERS,
  canOpenInSlicer,
  isReachableByDesktop,
  slicerUrl,
  slicersFor,
} from './slicers'

/**
 * Printer adapters, against a stubbed fetch.
 *
 * No hardware needed: what matters is that each protocol is addressed the way
 * its API actually expects, and that a printer being off produces something a
 * person can act on rather than "fetch failed".
 */

const octoprint: PrintHostConfig = {
  id: 'h1',
  name: 'OctoPi',
  protocol: 'octoprint',
  endpoint: 'http://octopi.local',
  apiKey: 'secret-key',
}
const moonraker: PrintHostConfig = { ...octoprint, protocol: 'moonraker', name: 'Voron' }
const prusalink: PrintHostConfig = { ...octoprint, protocol: 'prusalink', name: 'MK4' }

const gcode = { filename: 'benchy.gcode', data: new TextEncoder().encode('G28\nG1 X0\n') }

function stub(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  return vi.fn(async (input: unknown, init?: RequestInit) =>
    handler(String(input), init),
  ) as unknown as typeof fetch
}

const ok = (body: unknown = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

describe('endpoint validation', () => {
  it('accepts http and https', () => {
    expect(isValidEndpoint('http://octopi.local')).toBe(true)
    expect(isValidEndpoint('https://printer.example.com:7125')).toBe(true)
  })

  /*
   * The endpoint is admin-configured but still becomes an outbound request from
   * the server, so a non-http scheme is a way to make the worker read something
   * it should not.
   */
  it('refuses anything that is not an http URL', () => {
    for (const bad of ['file:///etc/passwd', 'ftp://host/x', 'not a url', '', 'javascript:1']) {
      expect(isValidEndpoint(bad), bad).toBe(false)
    }
  })

  it('refuses to send to an invalid endpoint', async () => {
    const result = await sendToPrinter({ ...octoprint, endpoint: 'file:///etc' }, gcode)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/http/i)
  })
})

describe('canSendToPrinter', () => {
  it('accepts sliced output', () => {
    for (const ext of ['gcode', 'bgcode', 'sl1', 'ctb', '3mf', '.GCODE']) {
      expect(canSendToPrinter(ext), ext).toBe(true)
    }
  })

  it('refuses a mesh, which means nothing to a printer', () => {
    for (const ext of ['stl', 'obj', 'ply', 'step', 'png']) {
      expect(canSendToPrinter(ext), ext).toBe(false)
    }
  })

  it('refuses to send an unsliced file even if asked', async () => {
    const result = await sendToPrinter(octoprint, {
      filename: 'body.stl',
      data: new Uint8Array(4),
    })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/sliced/i)
  })
})

describe('OctoPrint', () => {
  it('uploads to the local storage endpoint with the API key', async () => {
    let seenUrl = ''
    let seenKey: string | undefined
    const fetchImpl = stub((url, init) => {
      seenUrl = url
      seenKey = new Headers(init?.headers).get('x-api-key') ?? undefined
      return ok({ files: { local: { path: 'benchy.gcode' } } })
    })

    const result = await sendToPrinter(octoprint, gcode, {}, fetchImpl)

    expect(result.ok).toBe(true)
    expect(seenUrl).toBe('http://octopi.local/api/files/local')
    expect(seenKey).toBe('secret-key')
    expect(result.remotePath).toBe('benchy.gcode')
  })

  it('asks the printer to start when told to', async () => {
    let printed = false
    const fetchImpl = stub(async (_url, init) => {
      const form = init?.body as FormData
      printed = form.get('print') === 'true'
      return ok({})
    })

    await sendToPrinter(octoprint, gcode, { startPrint: true }, fetchImpl)
    expect(printed).toBe(true)
  })

  /*
   * Setting Content-Type by hand omits the multipart boundary, which produces a
   * body the server cannot parse — a classic and confusing failure.
   */
  it('lets fetch set the multipart content type', async () => {
    let contentType: string | null = null
    const fetchImpl = stub((_url, init) => {
      contentType = new Headers(init?.headers).get('content-type')
      return ok({})
    })

    await sendToPrinter(octoprint, gcode, {}, fetchImpl)
    expect(contentType).toBeNull()
  })

  it('trims a trailing slash from the endpoint', async () => {
    let seenUrl = ''
    const fetchImpl = stub((url) => {
      seenUrl = url
      return ok({})
    })
    await sendToPrinter({ ...octoprint, endpoint: 'http://octopi.local/' }, gcode, {}, fetchImpl)
    expect(seenUrl).toBe('http://octopi.local/api/files/local')
  })
})

describe('Moonraker', () => {
  it('uploads to the Moonraker endpoint', async () => {
    let seenUrl = ''
    const fetchImpl = stub((url) => {
      seenUrl = url
      return ok({})
    })
    const result = await sendToPrinter(moonraker, gcode, {}, fetchImpl)

    expect(result.ok).toBe(true)
    expect(seenUrl).toBe('http://octopi.local/server/files/upload')
  })

  it('sends print=false explicitly when not starting', async () => {
    // Moonraker defaults to starting the print if the flag is absent, so it
    // must be sent either way.
    let printField: unknown = null
    const fetchImpl = stub((_url, init) => {
      printField = (init?.body as FormData).get('print')
      return ok({})
    })
    await sendToPrinter(moonraker, gcode, { startPrint: false }, fetchImpl)
    expect(printField).toBe('false')
  })

  it('probes the Moonraker-specific info endpoint', async () => {
    let seenUrl = ''
    const fetchImpl = stub((url) => {
      seenUrl = url
      return ok({ result: { software_version: 'v0.9.3', state: 'ready' } })
    })
    const status = await probeHost(moonraker, fetchImpl)

    expect(seenUrl).toBe('http://octopi.local/printer/info')
    expect(status.ok).toBe(true)
    expect(status.version).toBe('v0.9.3')
    expect(status.state).toBe('ready')
  })
})

describe('PrusaLink', () => {
  it('PUTs raw bytes rather than multipart', async () => {
    let method: string | undefined
    let seenUrl = ''
    const fetchImpl = stub((url, init) => {
      seenUrl = url
      method = init?.method
      return ok({})
    })

    const result = await sendToPrinter(prusalink, gcode, {}, fetchImpl)

    expect(result.ok).toBe(true)
    expect(method).toBe('PUT')
    expect(seenUrl).toBe('http://octopi.local/api/v1/files/usb/benchy.gcode')
  })

  it('sets the print-after-upload header', async () => {
    // Without it PrusaLink stores the file but never starts it.
    let header: string | null = null
    const fetchImpl = stub((_url, init) => {
      header = new Headers(init?.headers).get('print-after-upload')
      return ok({})
    })

    await sendToPrinter(prusalink, gcode, { startPrint: true }, fetchImpl)
    expect(header).toBe('1')
  })

  it('encodes an awkward filename into the path', async () => {
    let seenUrl = ''
    const fetchImpl = stub((url) => {
      seenUrl = url
      return ok({})
    })
    await sendToPrinter(
      prusalink,
      { filename: 'dragon knight #2.gcode', data: gcode.data },
      {},
      fetchImpl,
    )
    expect(seenUrl).toContain('dragon%20knight%20%232.gcode')
  })
})

describe('errors people can act on', () => {
  it('explains a rejected API key', async () => {
    const fetchImpl = stub(() => new Response('nope', { status: 401 }))
    const result = await sendToPrinter(octoprint, gcode, {}, fetchImpl)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/api key/i)
  })

  it('explains a busy printer', async () => {
    const fetchImpl = stub(() => new Response('busy', { status: 409 }))
    expect((await sendToPrinter(octoprint, gcode, {}, fetchImpl)).error).toMatch(/busy/i)
  })

  it('explains a wrong address', async () => {
    const fetchImpl = stub(() => new Response('nope', { status: 404 }))
    expect((await sendToPrinter(octoprint, gcode, {}, fetchImpl)).error).toMatch(
      /address|endpoint/i,
    )
  })

  /*
   * "fetch failed" tells someone nothing. The usual causes are a printer that
   * is switched off or a hostname that does not resolve, and saying so saves a
   * support round trip.
   */
  it('explains a printer that is switched off', async () => {
    const fetchImpl = stub(() => {
      const error = new Error('connect ECONNREFUSED')
      ;(error as Error & { cause?: unknown }).cause = { code: 'ECONNREFUSED' }
      throw error
    })
    const result = await sendToPrinter(octoprint, gcode, {}, fetchImpl)
    expect(result.error).toMatch(/refused the connection/i)
  })

  it('explains a hostname that does not resolve', async () => {
    const fetchImpl = stub(() => {
      const error = new Error('getaddrinfo ENOTFOUND')
      ;(error as Error & { cause?: unknown }).cause = { code: 'ENOTFOUND' }
      throw error
    })
    expect((await sendToPrinter(octoprint, gcode, {}, fetchImpl)).error).toMatch(/resolve/i)
  })

  /*
   * undici hides the real reason behind a bare TypeError("fetch failed"), and
   * nests it one level further when a host resolves to several addresses.
   */
  it('reads the reason out of an AggregateError', async () => {
    const fetchImpl = stub(() => {
      const error = new TypeError('fetch failed')
      ;(error as Error & { cause?: unknown }).cause = {
        name: 'AggregateError',
        errors: [{ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' }],
      }
      throw error
    })
    expect((await sendToPrinter(octoprint, gcode, {}, fetchImpl)).error).toMatch(
      /refused the connection/i,
    )
  })

  it('names the endpoint when the reason is not one it knows', async () => {
    // "fetch failed" on its own tells nobody anything.
    const fetchImpl = stub(() => {
      const error = new TypeError('fetch failed')
      ;(error as Error & { cause?: unknown }).cause = { message: 'bad port' }
      throw error
    })
    const result = await sendToPrinter(octoprint, gcode, {}, fetchImpl)
    expect(result.error).toContain('octopi.local')
    expect(result.error).toContain('bad port')
  })

  it('never leaves the caller with a bare "fetch failed"', async () => {
    const fetchImpl = stub(() => {
      throw new TypeError('fetch failed')
    })
    const result = await sendToPrinter(octoprint, gcode, {}, fetchImpl)
    expect(result.error).not.toBe('fetch failed')
    expect(result.error).toContain('octopi.local')
  })

  it('explains an expired certificate', async () => {
    const fetchImpl = stub(() => {
      const error = new TypeError('fetch failed')
      ;(error as Error & { cause?: unknown }).cause = { code: 'CERT_HAS_EXPIRED' }
      throw error
    })
    expect((await sendToPrinter(octoprint, gcode, {}, fetchImpl)).error).toMatch(/certificate/i)
  })

  it('explains a timeout', async () => {
    const fetchImpl = stub(() => {
      const error = new Error('timed out')
      error.name = 'TimeoutError'
      throw error
    })
    expect((await probeHost(octoprint, fetchImpl)).error).toMatch(/did not respond/i)
  })
})

describe('slicer handoff', () => {
  it('offers every slicer for a mesh we can deliver', () => {
    // All of them read 3MF, and 3MF is what every hand-off is delivered as.
    const forStl = slicersFor('stl').map((s) => s.id)
    expect(forStl).toContain('bambustudio')
    expect(forStl).toContain('orcaslicer')
    expect(forStl).toContain('prusaslicer')
    expect(forStl).toContain('cura')
    expect(forStl).toContain('lychee')
  })

  /*
   * STEP is the case that made this rule necessary. Slicers read it, so it was
   * offered — but delivery goes over as 3MF and we cannot produce one from a
   * CAD kernel format, so every one of those links failed at the server. A
   * link that cannot work is worse than no link.
   */
  it('offers nothing for a format it cannot convert, however well slicers read it', () => {
    expect(slicersFor('step')).toEqual([])
    expect(slicersFor('stp')).toEqual([])
    expect(slicersFor('amf')).toEqual([])

    expect(canOpenInSlicer('step')).toBe(false)
  })

  // The inverse: PLY converts perfectly and used to be offered by nobody,
  // because no slicer lists it natively.
  it('offers a format it can convert even when no slicer reads it natively', () => {
    expect(slicersFor('ply').length).toBeGreaterThan(0)
    expect(canOpenInSlicer('ply')).toBe(true)
  })

  it('passes an existing 3MF straight through', () => {
    expect(slicersFor('3mf').length).toBeGreaterThan(0)
  })

  it('offers nothing for a file that is not a mesh at all', () => {
    expect(slicersFor('png')).toEqual([])
    expect(slicersFor('gcode')).toEqual([])
    expect(slicersFor('')).toEqual([])
  })

  it('ignores a leading dot and case', () => {
    expect(canOpenInSlicer('.STL')).toBe(true)
    expect(slicersFor('.Obj').length).toBeGreaterThan(0)
  })

  /*
   * The offer and the converter have to agree. They came apart once already,
   * in both directions at the same time.
   */
  it('never offers a slicer for something the converter would refuse', () => {
    for (const extension of ['step', 'stp', 'amf', 'gcode', 'png', 'zip']) {
      expect(slicersFor(extension), extension).toEqual([])
    }
    for (const extension of CONVERTIBLE_TO_3MF) {
      expect(slicersFor(extension).length, extension).toBeGreaterThan(0)
    }
  })

  it('builds a handoff link with the file URL encoded', () => {
    const slicer = SLICERS.find((s) => s.id === 'bambustudio')!
    const url = slicerUrl(slicer, 'https://prints.example.com/api/files/abc/raw?token=x&y=1')

    expect(url.startsWith('bambustudio://open?file=')).toBe(true)
    // Unencoded, the second parameter would be read as part of the slicer URL
    // rather than the file URL.
    expect(url).toContain('%3Ftoken%3Dx%26y%3D1')
  })

  it('covers every slicer the plan named', () => {
    expect(SLICERS.map((s) => s.id).sort()).toEqual([
      'bambustudio',
      'cura',
      'lychee',
      'orcaslicer',
      'prusaslicer',
    ])
  })

  it('recognises a URL a desktop application can fetch', () => {
    expect(isReachableByDesktop('https://prints.example.com/x')).toBe(true)
    expect(isReachableByDesktop('http://192.168.1.5:8080/x')).toBe(true)
    expect(isReachableByDesktop('/api/files/abc/raw')).toBe(false)
  })
})
