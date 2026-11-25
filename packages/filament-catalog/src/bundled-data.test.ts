import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { BUNDLED_DATA_DIR, readSnapshot } from './files'
import { verifyDataset } from './verify'

/*
 * Guards the committed catalogue. `npm run filaments:update` writes it; this
 * fails CI if what was committed is inconsistent — a hand edit, files from two
 * runs, or a logo that was referenced but never added.
 */
describe('bundled filament catalogue', () => {
  it('is internally consistent and matches snapshot.json', async () => {
    const { problems } = await verifyDataset(BUNDLED_DATA_DIR)
    expect(problems).toEqual([])
  })

  it('has every referenced logo in the web public directory', async () => {
    const { logoPaths } = await verifyDataset(BUNDLED_DATA_DIR)
    const publicDir = fileURLToPath(new URL('../../../apps/web/public', import.meta.url))
    const missing = logoPaths.filter((p) => !existsSync(publicDir + p))
    expect(missing).toEqual([])
  })

  it('records where the data came from and its licence', async () => {
    const snapshot = await readSnapshot()
    expect(snapshot.source).toBe('open-filament-database')
    expect(snapshot.licence).toBe('MIT')
    expect(snapshot.tag).toMatch(/^dataset-v\d{4}\.\d{2}\.\d{2}$/)
    expect(existsSync(`${BUNDLED_DATA_DIR}LICENSE-OFD`)).toBe(true)
  })
})
