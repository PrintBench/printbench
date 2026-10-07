export type ProcessRole = 'web' | 'worker'

/**
 * Which process this is.
 *
 * Carried in the environment rather than a module variable: Next bundles
 * instrumentation separately from route code, so module state set at boot is
 * not the module state a request sees. The environment is shared by both.
 */
export function processRole(): ProcessRole {
  return process.env.PB_PROCESS_ROLE === 'worker' ? 'worker' : 'web'
}

export function setProcessRole(role: ProcessRole): void {
  process.env.PB_PROCESS_ROLE = role
}
