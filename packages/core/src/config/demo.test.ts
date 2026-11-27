import { afterEach, describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import { DemoModeError, assertDemoAllows, demoConfig, isDemoMode } from './demo'
import {
  demoLibraryPath,
  demoResetOverdue,
  demoUploadsPath,
  isDemoSeededLibrary,
  nextDemoReset,
} from './demo-server'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('demo switch', () => {
  it('is off unless PRINTBENCH_DEMO is exactly 1', () => {
    vi.stubEnv('PRINTBENCH_DEMO', '')
    expect(isDemoMode()).toBe(false)
    vi.stubEnv('PRINTBENCH_DEMO', 'true')
    expect(isDemoMode()).toBe(false)
    vi.stubEnv('PRINTBENCH_DEMO', '1')
    expect(isDemoMode()).toBe(true)
  })

  it('throws only on a demo', () => {
    vi.stubEnv('PRINTBENCH_DEMO', '')
    expect(() => assertDemoAllows('x')).not.toThrow()
    vi.stubEnv('PRINTBENCH_DEMO', '1')
    expect(() => assertDemoAllows('x')).toThrow(DemoModeError)
  })

  it('has working defaults and honours overrides', () => {
    expect(demoConfig()).toMatchObject({
      email: 'demo@printbench.app',
      resetCron: '0 0 * * *',
      libraryPath: '/libraries',
    })
    vi.stubEnv('DEMO_MAX_UPLOAD_BYTES', '1024')
    vi.stubEnv('DEMO_MAX_STORAGE_BYTES', 'lots')
    expect(demoConfig().maxUploadBytes).toBe(1024)
    // A typo falls back to the default rather than to "unlimited".
    expect(demoConfig().maxStorageBytes).toBe(1024 * 1024 * 1024)
  })
})

describe('demo reset schedule', () => {
  it('is midnight UTC, whatever the time of day', () => {
    expect(nextDemoReset(new Date('2026-11-27T23:59:00Z'), '0 0 * * *').toISOString()).toBe(
      '2026-11-28T00:00:00.000Z',
    )
    expect(nextDemoReset(new Date('2026-11-27T00:00:00Z'), '0 0 * * *').toISOString()).toBe(
      '2026-11-28T00:00:00.000Z',
    )
  })

  // A broken cron must not mean a demo that never resets.
  it('falls back to midnight when the cron does not parse', () => {
    expect(nextDemoReset(new Date('2026-11-27T12:00:00Z'), 'not a cron').toISOString()).toBe(
      '2026-11-28T00:00:00.000Z',
    )
  })

  it('knows when a boot has missed a reset', () => {
    const seeded = new Date('2026-11-27T00:00:05Z')
    expect(demoResetOverdue(seeded, new Date('2026-11-27T23:59:59Z'), '0 0 * * *')).toBe(false)
    expect(demoResetOverdue(seeded, new Date('2026-11-28T00:00:00Z'), '0 0 * * *')).toBe(true)
    expect(demoResetOverdue(seeded, new Date('2026-11-30T09:00:00Z'), '0 0 * * *')).toBe(true)
  })
})

describe('seeded libraries', () => {
  it('protects the two libraries the reset creates, only on a demo', () => {
    vi.stubEnv('DEMO_LIBRARY_PATH', '/srv/demo')
    vi.stubEnv('MANAGED_LIBRARY_ROOT', '/data/libraries')
    expect(isDemoSeededLibrary('/srv/demo')).toBe(false)

    vi.stubEnv('PRINTBENCH_DEMO', '1')
    expect(demoLibraryPath()).toBe(path.resolve('/srv/demo'))
    expect(isDemoSeededLibrary('/srv/demo/')).toBe(true)
    expect(isDemoSeededLibrary(demoUploadsPath())).toBe(true)
    expect(isDemoSeededLibrary('/data/libraries/someone-elses')).toBe(false)
    expect(isDemoSeededLibrary(null)).toBe(false)
  })
})
