import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import { MAX_3MF_EXPANDED_BYTES, readThreeMf } from './threemf'

/** Change a central-directory length without allocating the claimed bytes. */
function setExpandedSizes(archive: Uint8Array, sizes: number[]): Uint8Array {
  const copy = archive.slice()
  const view = new DataView(copy.buffer, copy.byteOffset, copy.byteLength)
  let next = 0
  for (let i = 0; i + 46 <= copy.length; i++) {
    if (view.getUint32(i, true) !== 0x02014b50) continue
    if (next < sizes.length) view.setUint32(i + 24, sizes[next++]!, true)
    i +=
      45 +
      view.getUint16(i + 28, true) +
      view.getUint16(i + 30, true) +
      view.getUint16(i + 32, true)
  }
  expect(next).toBe(sizes.length)
  return copy
}

describe('3MF memory bounds', () => {
  it('refuses an oversized expanded part before inflating it', () => {
    const zip = zipSync({ '3D/3dmodel.model': strToU8('<model/>') })
    expect(() =>
      readThreeMf(setExpandedSizes(zip, [MAX_3MF_EXPANDED_BYTES + 1]), () => {}),
    ).toThrow('expanded geometry and images')
  })

  it('budgets the sum of parts, not just each individual entry', () => {
    const zip = zipSync({
      '3D/3dmodel.model': strToU8('<model/>'),
      'Metadata/thumbnail.png': new Uint8Array(1),
    })
    // The first small entry is real; the second pushes their sum past the cap.
    expect(() => readThreeMf(setExpandedSizes(zip, [8, MAX_3MF_EXPANDED_BYTES]), () => {})).toThrow(
      'expanded geometry and images',
    )
  })

  it('does not inflate unrelated slicer G-code', () => {
    // This ZIP's ignored entry claims a huge output. Extraction must skip it.
    // Add an independent archive fixture using the normal geometry XML.
    const xml =
      '<model><resources><object id="1"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object></resources><build><item objectid="1"/></build></model>'
    const zip = zipSync({
      'Metadata/plate.gcode': new Uint8Array(1),
      '3D/3dmodel.model': strToU8(xml),
    })
    expect(
      readThreeMf(setExpandedSizes(zip, [MAX_3MF_EXPANDED_BYTES + 1]), () => {}).triangleCount,
    ).toBe(1)
  })

  it('parses dense geometry inside a fixed 128 MiB heap', () => {
    const script = fileURLToPath(
      new URL('../../../../scripts/benchmark-mesh-memory.mts', import.meta.url),
    )
    const result = spawnSync(process.execPath, ['--import', 'tsx', script, '250000', '128'], {
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
    })
    expect(result.error, result.stderr).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout).triangles).toBe(250_000)
  }, 130_000)
})
