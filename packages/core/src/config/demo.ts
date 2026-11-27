/**
 * Demo instance switch.
 *
 * demo.printbench.app runs the ordinary image with PRINTBENCH_DEMO=1: one shared
 * account, a scripted library, and a nightly reset back to it. This is an
 * operator setting for that one deployment, not a product feature, which is
 * why it is absent from .env.example and the docs.
 *
 * Kept free of Node imports on purpose. The policy module calls isDemoMode()
 * and the sidebar runs that policy in the browser, where process.env is an
 * empty object and the flag arrives on the user instead.
 */

export const DEMO_UNAVAILABLE = 'Not available in the demo.'

export function isDemoMode(): boolean {
  return typeof process !== 'undefined' && process.env?.PRINTBENCH_DEMO === '1'
}

export interface DemoConfig {
  /** The shared account every visitor signs in with. */
  email: string
  /** Public on purpose: it is printed on the login page. */
  password: string
  name: string
  /** When the instance is put back, evaluated in UTC. */
  resetCron: string
  /** Largest single upload a visitor may send. */
  maxUploadBytes: number
  /** Total bytes visitors may add to managed libraries before uploads stop. */
  maxStorageBytes: number
  /** Where the read-only shop-window library is mounted. */
  libraryPath: string
}

const MB = 1024 * 1024

export function demoConfig(): DemoConfig {
  return {
    email: env('DEMO_EMAIL') ?? 'demo@printbench.app',
    password: env('DEMO_PASSWORD') ?? 'printbench-demo',
    name: env('DEMO_NAME') ?? 'Demo Maker',
    resetCron: env('DEMO_RESET_CRON') ?? '0 0 * * *',
    maxUploadBytes: bytes('DEMO_MAX_UPLOAD_BYTES', 50 * MB),
    maxStorageBytes: bytes('DEMO_MAX_STORAGE_BYTES', 1024 * MB),
    libraryPath: env('DEMO_LIBRARY_PATH') ?? '/libraries',
  }
}

/** Thrown by code paths that have no result type to return the refusal in. */
export class DemoModeError extends Error {
  constructor(readonly feature: string) {
    super(DEMO_UNAVAILABLE)
    this.name = 'DemoModeError'
  }
}

export function assertDemoAllows(feature: string): void {
  if (isDemoMode()) throw new DemoModeError(feature)
}

function env(name: string): string | undefined {
  const value = process.env[name]?.trim()
  return value ? value : undefined
}

function bytes(name: string, fallback: number): number {
  const value = Number(env(name))
  return Number.isFinite(value) && value > 0 ? value : fallback
}
