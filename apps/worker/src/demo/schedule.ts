import { nextDemoReset } from '@pb/core'
import { demoNeedsReset, resetDemo, type DemoResetDeps } from './reset'

/**
 * Runs the nightly demo reset.
 *
 * A plain timer, not a pg-boss schedule: the reset stops the job queue, and a
 * job cannot stop the queue it is running on. The worker is a single process,
 * so there is nobody to race.
 *
 * `onResetting` lets the HTTP layer refuse uploads while files and rows are
 * being swapped underneath it.
 */
export interface DemoScheduler {
  /** Resets now if the boot finds the demo empty or overdue. Returns whether it did. */
  catchUp(): Promise<boolean>
  /** Arms the timer for the next reset, and every one after it. */
  arm(): void
  stop(): void
}

/** setTimeout cannot wait more than about 24.8 days; a long schedule re-checks instead. */
const MAX_DELAY = 2 ** 31 - 1

export function createDemoScheduler(
  deps: DemoResetDeps & { onResetting: (resetting: boolean) => void },
): DemoScheduler {
  let timer: NodeJS.Timeout | undefined
  let running: Promise<unknown> | undefined

  async function run(options: { paused?: boolean } = {}): Promise<void> {
    if (running) return
    deps.onResetting(true)
    running = resetDemo(deps, options)
    try {
      await running
    } finally {
      running = undefined
      deps.onResetting(false)
    }
  }

  function arm(): void {
    clearTimeout(timer)
    const at = nextDemoReset()
    const delay = Math.min(Math.max(at.getTime() - Date.now(), 1000), MAX_DELAY)
    timer = setTimeout(() => {
      void (async () => {
        // A timer that woke early for a long schedule just waits again.
        if (await demoNeedsReset(deps.db)) {
          await run().catch(() => undefined)
        }
        arm()
      })()
    }, delay)
    timer.unref()
    console.log(`[demo] next reset at ${at.toISOString()}`)
  }

  return {
    async catchUp() {
      if (!(await demoNeedsReset(deps.db))) return false
      // Called before work starts, so there is nothing to pause.
      await run({ paused: true })
      return true
    },
    arm,
    stop() {
      clearTimeout(timer)
    },
  }
}
