import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DemoQuotaError, assertDemoQuota, directoryBytes, uploadMaxSize } from './quota'

describe('demo upload quota', () => {
  let work = ''

  beforeEach(async () => {
    work = await mkdtemp(path.join(tmpdir(), 'pb-demo-quota-'))
    vi.stubEnv('MANAGED_LIBRARY_ROOT', path.join(work, 'managed'))
    await mkdir(path.join(work, 'managed', 'uploads'), { recursive: true })
    await writeFile(path.join(work, 'managed', 'uploads', 'a.stl'), Buffer.alloc(600))
    await mkdir(path.join(work, 'staging'))
    await writeFile(path.join(work, 'staging', 'partial'), Buffer.alloc(300))
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    await rm(work, { recursive: true, force: true })
  })

  it('counts nested files, and a missing folder as empty', async () => {
    expect(await directoryBytes(path.join(work, 'managed'))).toBe(600)
    expect(await directoryBytes(path.join(work, 'nowhere'))).toBe(0)
  })

  it('does nothing outside a demo', async () => {
    vi.stubEnv('DEMO_MAX_STORAGE_BYTES', '1')
    await expect(assertDemoQuota(10_000, path.join(work, 'staging'))).resolves.toBeUndefined()
    expect(uploadMaxSize(8_000)).toBe(8_000)
  })

  // Staged bytes count: a big upload in flight already occupies the disk.
  it('refuses the upload that would cross the quota, counting staging too', async () => {
    vi.stubEnv('PRINTBENCH_DEMO', '1')
    vi.stubEnv('DEMO_MAX_STORAGE_BYTES', '1000')
    vi.stubEnv('DEMO_MAX_UPLOAD_BYTES', '500')
    const staging = path.join(work, 'staging')
    await expect(assertDemoQuota(100, staging)).resolves.toBeUndefined()
    await expect(assertDemoQuota(101, staging)).rejects.toThrow(DemoQuotaError)
    expect(uploadMaxSize(8_000)).toBe(500)
  })
})
