import { browser } from './browser'
import {
  ApiError,
  errorMessage,
  fetchImport,
  fetchLibraries,
  hostPermission,
  modelSource,
  type Connection,
  type ImportInput,
  type Library,
} from './client'
import {
  CONNECTION,
  LAST_LIBRARY,
  LATEST_IMPORT,
  readConnection,
  readLatestImport,
  readStorage,
  rememberLibrary,
} from './storage'

const settings = document.querySelector<HTMLButtonElement>('#settings')!
const note = document.querySelector<HTMLParagraphElement>('#page-note')!
const form = document.querySelector<HTMLFormElement>('#send-form')!
const library = document.querySelector<HTMLSelectElement>('#library')!
const send = document.querySelector<HTMLButtonElement>('#send')!
const requestError = document.querySelector<HTMLParagraphElement>('#request-error')!
const latestSection = document.querySelector<HTMLElement>('#latest')!
const status = document.querySelector<HTMLParagraphElement>('#status')!
const detail = document.querySelector<HTMLParagraphElement>('#status-detail')!
const openModel = document.querySelector<HTMLAnchorElement>('#open-model')!
const accountSettings = document.querySelector<HTMLAnchorElement>('#account-settings')!
const retry = document.querySelector<HTMLButtonElement>('#retry')!
const refresh = document.querySelector<HTMLButtonElement>('#refresh')!

let connection: Connection | undefined
let source: ReturnType<typeof modelSource>
let libraries: Library[] = []
let submitting = false
let revision = 0
let pollTimer: ReturnType<typeof setTimeout> | undefined

function showError(error: unknown) {
  requestError.textContent = errorMessage(error)
  requestError.hidden = false
}

function showDetail(message: string) {
  detail.textContent = message
  detail.hidden = !message
}

function setBusy(busy: boolean) {
  submitting = busy
  library.disabled = busy
  send.disabled = busy
  retry.disabled = busy
}

async function submit(input: ImportInput) {
  if (submitting || !connection) return
  setBusy(true)
  requestError.hidden = true
  try {
    const result = (await browser.runtime.sendMessage({
      ...input,
      connectionId: connection.id,
    })) as { error?: string } | undefined
    if (!result) throw new Error('Could not confirm the submission. Try again.')
    if (result.error) throw new Error(result.error)
  } catch (error) {
    showError(error)
  } finally {
    setBusy(false)
    await updateLatest()
  }
}

async function updateLatest() {
  clearTimeout(pollTimer)
  const current = ++revision
  const connected = connection
  if (!connected) return
  const latest = await readLatestImport(connected)
  if (current !== revision) return

  latestSection.hidden = !latest
  openModel.hidden = true
  accountSettings.hidden = true
  retry.hidden = true
  refresh.hidden = true
  showDetail('')
  if (!latest) return

  const retryAvailable = libraries.some(({ id }) => id === latest.input.libraryId)
  retry.onclick = () => void submit(latest.input).catch(showError)
  accountSettings.href = connected.origin + '/settings'
  if (!latest.id) {
    status.textContent = latest.submissionError
      ? 'Could not submit import'
      : submitting
        ? 'Sending to PrintBench…'
        : 'Waiting for submission confirmation'
    showDetail(latest.submissionError ?? '')
    accountSettings.hidden = !latest.settingsHint && !latest.submissionError
    retry.hidden = !retryAvailable
    return
  }

  if (!status.textContent) status.textContent = 'Checking import…'
  try {
    const result = await fetchImport(connected, latest.id)
    if (current !== revision) return

    switch (result.state) {
      case 'queued':
      case 'importing':
        status.textContent = result.state === 'queued' ? 'Queued' : 'Importing…'
        pollTimer = setTimeout(() => void updateLatest().catch(showError), 2000)
        break
      case 'complete':
        status.textContent = 'Import complete'
        if (result.publicId) {
          openModel.href = connected.origin + '/models/' + encodeURIComponent(result.publicId)
          openModel.hidden = false
        }
        await rememberLibrary(connected, latest.input.libraryId)
        break
      case 'failed':
        status.textContent = 'Import failed'
        showDetail(result.error ?? 'Try importing this model again.')
        accountSettings.hidden = false
        retry.hidden = !retryAvailable
        break
      default:
        throw new Error('PrintBench did not return an import status.')
    }
  } catch (error) {
    if (current !== revision) return
    status.textContent = 'Could not check import'
    showDetail(errorMessage(error))
    accountSettings.hidden = !(error instanceof ApiError && error.status === 401)
    refresh.hidden = false
  }
}

async function initialize() {
  connection = await readConnection()
  if (!connection) {
    note.textContent = 'Open Settings to connect this browser to PrintBench.'
    return
  }
  if (!(await browser.permissions.contains(hostPermission(connection.origin)))) {
    note.textContent = 'Open Settings, then disconnect and reconnect to restore server access.'
    return
  }
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true })
  source = modelSource(tab?.url)
  note.textContent = source
    ? 'Loading libraries…'
    : 'Open a supported MakerWorld, Printables, or Thingiverse model page to send it.'
  try {
    libraries = await fetchLibraries(connection)
    await updateLatest()
    if (source) {
      note.textContent = libraries.length
        ? new URL(source.sourceUrl).hostname.replace(/^www\./, '')
        : 'No libraries are available. Ask a PrintBench administrator to configure writable storage and enable scanning.'
      const last = await readStorage<{ connectionId: string; libraryId: string }>(LAST_LIBRARY)
      library.replaceChildren(
        ...(libraries.length > 1 ? [new Option('Choose a library', '')] : []),
        ...libraries.map(
          ({ id, name, backend }) =>
            new Option(name + ' (' + (backend === 's3' ? 'S3' : 'Local') + ')', id),
        ),
      )
      if (
        last?.connectionId === connection.id &&
        libraries.some(({ id }) => id === last.libraryId)
      ) {
        library.value = last.libraryId
      }
      form.hidden = libraries.length === 0
    }
  } catch (error) {
    if (source) note.textContent = 'Could not load libraries.'
    showError(error)
    await updateLatest()
  }
}

settings.addEventListener('click', () => void browser.runtime.openOptionsPage().catch(showError))
form.addEventListener('submit', (event) => {
  event.preventDefault()
  if (source && library.value) {
    void submit({ libraryId: library.value, url: source.sourceUrl }).catch(showError)
  }
})
refresh.addEventListener('click', () => void updateLatest().catch(showError))
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return
  if (CONNECTION in changes) window.location.reload()
  else if (LATEST_IMPORT in changes) void updateLatest().catch(showError)
})

void initialize().catch(showError)
