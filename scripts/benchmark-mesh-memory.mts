/** Reproducible dense-3MF workload, parsed in a separate, heap-limited process. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { zipSync, strToU8 } from 'fflate'
import { readThreeMf } from '../packages/mesh/src/parse/threemf'

if (process.argv[2] === '--parse') {
  const archive = readFileSync(process.argv[3]!)
  const started = performance.now()
  const stats = readThreeMf(archive, () => {})
  console.log(
    JSON.stringify({
      triangles: stats.triangleCount,
      elapsedMs: Math.round(performance.now() - started),
      peakRssMiB: Math.round(process.resourceUsage().maxRSS / 1024),
      heapUsedMiB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      archiveBytes: archive.byteLength,
    }),
  )
} else {
  const count = Number(process.argv[2] ?? 100_000)
  const heap = Number(process.argv[3] ?? 128)
  if (
    !Number.isSafeInteger(count) ||
    count < 1 ||
    count > 1_000_000 ||
    !Number.isSafeInteger(heap) ||
    heap < 64 ||
    heap > 4096
  ) {
    throw new Error('Usage: benchmark-mesh-memory.mts [triangles:1..1000000] [heap-MiB:64..4096]')
  }
  const dir = mkdtempSync(path.join(tmpdir(), 'printbench-mesh-memory-'))
  try {
    const filename = path.join(dir, 'dense.3mf')
    // Repeated independent triangles still exercise the full indexed XML data
    // structures. Fixture generation runs outside the measured child process.
    const vertices =
      '<vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/>'.repeat(
        count,
      )
    const triangles = Array.from(
      { length: count },
      (_, i) => `<triangle v1="${i * 3}" v2="${i * 3 + 1}" v3="${i * 3 + 2}"/>`,
    ).join('')
    const xml = `<model unit="millimeter"><resources><object id="1"><mesh><vertices>${vertices}</vertices><triangles>${triangles}</triangles></mesh></object></resources><build><item objectid="1"/></build></model>`
    writeFileSync(filename, zipSync({ '3D/3dmodel.model': strToU8(xml) }))
    const result = spawnSync(
      process.execPath,
      [
        `--max-old-space-size=${heap}`,
        '--import',
        'tsx',
        fileURLToPath(import.meta.url),
        '--parse',
        filename,
      ],
      { encoding: 'utf8', timeout: 120_000, maxBuffer: 1024 * 1024 },
    )
    process.stdout.write(result.stdout ?? '')
    if (result.status !== 0) {
      process.stderr.write((result.stderr ?? '').slice(-4000))
      console.error(
        `Parser failed: status=${result.status}, signal=${result.signal}, error=${result.error?.message ?? 'none'}`,
      )
      process.exitCode = 1
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
