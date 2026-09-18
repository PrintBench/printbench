import type { JobHandler, JobName } from '@pb/jobs'

/** Opt-in, process-wide measurements; concurrent jobs share these numbers. */
export function reportMemory(context: Record<string, unknown>): void {
  if (process.env.WORKER_MEMORY_LOG !== '1') return
  const memory = process.memoryUsage()
  const mib = (bytes: number) => Math.round(bytes / 1024 / 1024)
  console.info(
    '[worker-memory]',
    JSON.stringify({
      ...context,
      rssMiB: mib(memory.rss),
      heapUsedMiB: mib(memory.heapUsed),
      externalMiB: mib(memory.external),
      arrayBuffersMiB: mib(memory.arrayBuffers),
      // Node reports maxRSS in KiB on both Linux and macOS.
      processPeakRssMiB: Math.round(process.resourceUsage().maxRSS / 1024),
    }),
  )
}

export function withMemoryDiagnostics<N extends JobName>(
  name: N,
  handler: JobHandler<N>,
): JobHandler<N> {
  return async (payload) => {
    if (process.env.WORKER_MEMORY_LOG !== '1') return handler(payload)
    const started = Date.now()
    const identity = {
      job: name,
      fileId: 'fileId' in payload ? payload.fileId : undefined,
      libraryId: 'libraryId' in payload ? payload.libraryId : undefined,
    }
    const report = (event: string) =>
      reportMemory({ ...identity, event, elapsedMs: Date.now() - started })
    report('start')
    const timer = setInterval(() => report('sample'), 15_000)
    timer.unref()
    let succeeded = false
    try {
      await handler(payload)
      succeeded = true
    } finally {
      clearInterval(timer)
      report(succeeded ? 'end' : 'error')
    }
  }
}
