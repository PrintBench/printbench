import { browser } from './browser'
import type { Connection, ImportInput } from './client'

export interface LatestImport {
  connectionId: string
  input: ImportInput
  id?: string
  submissionError?: string
  settingsHint?: boolean
}

export const CONNECTION = 'connection'
export const LATEST_IMPORT = 'latestImport'
export const LAST_LIBRARY = 'lastLibrary'

export async function readStorage<T>(key: string) {
  return (await browser.storage.local.get(key))[key] as T | undefined
}

export function readConnection() {
  return readStorage<Connection>(CONNECTION)
}

export function saveLatestImport(latest: LatestImport) {
  return browser.storage.local.set({ [LATEST_IMPORT]: latest })
}

export async function readLatestImport(connection: Connection) {
  const latest = await readStorage<LatestImport>(LATEST_IMPORT)
  return latest?.connectionId === connection.id ? latest : undefined
}

export async function rememberLibrary(connection: Connection, libraryId: string) {
  const last = await readStorage<{ connectionId: string; libraryId: string }>(LAST_LIBRARY)
  if (last?.connectionId !== connection.id || last.libraryId !== libraryId) {
    await browser.storage.local.set({ [LAST_LIBRARY]: { connectionId: connection.id, libraryId } })
  }
}
