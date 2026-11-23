import { browser } from './browser'
import { ApiError, errorMessage, modelSource, submitImport, type ImportInput } from './client'
import { readConnection, saveLatestImport } from './storage'

let submitting = false

async function sendImport({
  libraryId,
  url,
  connectionId,
}: ImportInput & { connectionId: string }) {
  if (submitting) throw new Error('Another import is being submitted. Try again in a moment.')
  submitting = true
  try {
    const connection = await readConnection()
    if (!connection || connection.id !== connectionId) {
      throw new Error('The PrintBench connection changed. Reopen the popup and try again.')
    }
    const source = modelSource(url)
    if (!source || !libraryId) throw new Error('Choose a library and open a supported model page.')
    const input = { libraryId, url: source.sourceUrl }
    const latest = { connectionId: connection.id, input }
    await saveLatestImport(latest)
    try {
      const { id } = await submitImport(connection, input)
      if (typeof id !== 'string' || !id) throw new Error('PrintBench did not return an import ID.')
      await saveLatestImport({ ...latest, id })
    } catch (error) {
      await saveLatestImport({
        ...latest,
        submissionError: errorMessage(error),
        settingsHint: error instanceof ApiError && error.status === 401,
      })
    }
  } finally {
    submitting = false
  }
}

browser.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.url !== browser.runtime.getURL('popup.html')) return false
  const input = message as Partial<ImportInput & { connectionId: string }> | null
  if (
    typeof input?.libraryId !== 'string' ||
    typeof input.url !== 'string' ||
    typeof input.connectionId !== 'string'
  )
    return false
  void sendImport({
    libraryId: input.libraryId,
    url: input.url,
    connectionId: input.connectionId,
  }).then(
    () => respond({}),
    (error) => respond({ error: errorMessage(error) }),
  )
  return true
})
