import { browser } from './browser'
import { errorMessage, fetchLibraries, hostPermission, installationOrigin } from './client'
import { CONNECTION, LAST_LIBRARY, LATEST_IMPORT, readConnection } from './storage'

const help = document.querySelector<HTMLParagraphElement>('#connection-help')!
const form = document.querySelector<HTMLFormElement>('#connect-form')!
const address = document.querySelector<HTMLInputElement>('#address')!
const token = document.querySelector<HTMLInputElement>('#token')!
const connect = document.querySelector<HTMLButtonElement>('#connect')!
const disconnect = document.querySelector<HTMLButtonElement>('#disconnect')!
const status = document.querySelector<HTMLParagraphElement>('#connection-status')!
const errorField = document.querySelector<HTMLParagraphElement>('#connection-error')!

document.querySelector('#extension-version')!.textContent =
  'Version ' + browser.runtime.getManifest().version

function showError(error: unknown) {
  errorField.textContent =
    error instanceof TypeError
      ? 'Enter a full PrintBench server address, such as http://localhost:8080.'
      : errorMessage(error)
  errorField.hidden = false
}

function setBusy(busy: boolean) {
  address.disabled = busy
  token.disabled = busy
  connect.disabled = busy
  disconnect.disabled = busy
}

async function showConnection() {
  const connection = await readConnection()
  form.hidden = Boolean(connection)
  help.hidden = Boolean(connection)
  disconnect.hidden = !connection
  status.textContent = connection ? 'Connected to ' + connection.origin : ''
}

async function saveConnection() {
  const origin = installationOrigin(address.value)
  const secret = token.value.trim()
  if (!/^pb_clip_[A-Za-z0-9_-]{43}$/.test(secret)) {
    throw new Error('Paste the connection token from PrintBench Account settings.')
  }
  const permission = hostPermission(origin)
  // Firefox requires the request itself to run in the submit gesture.
  if (!(await browser.permissions.request(permission))) {
    throw new Error('Grant access to the PrintBench server address to connect.')
  }
  const existing = await readConnection()
  const previousPermission = existing && hostPermission(existing.origin)
  const sameHost = previousPermission?.origins[0] === permission.origins[0]
  const connection = { id: crypto.randomUUID(), origin, token: secret }
  try {
    await fetchLibraries(connection)
    if (existing?.origin !== origin || existing.token !== secret) {
      await browser.storage.local.set({ [CONNECTION]: connection })
      await browser.storage.local.remove(LATEST_IMPORT)
      await browser.storage.local.remove(LAST_LIBRARY)
    }
  } catch (error) {
    if (!sameHost) await browser.permissions.remove(permission).catch(() => undefined)
    throw error
  }
  if (previousPermission && !sameHost) {
    await browser.permissions.remove(previousPermission).catch(() => undefined)
  }
  token.value = ''
  await showConnection()
}

form.addEventListener('submit', (event) => {
  event.preventDefault()
  setBusy(true)
  errorField.hidden = true
  void saveConnection()
    .catch(showError)
    .finally(() => setBusy(false))
})

disconnect.addEventListener('click', () => {
  setBusy(true)
  errorField.hidden = true
  void (async () => {
    const connection = await readConnection()
    await browser.storage.local.remove(CONNECTION)
    await browser.storage.local.remove(LATEST_IMPORT)
    await browser.storage.local.remove(LAST_LIBRARY)

    address.value = ''
    token.value = ''
    await showConnection()
    status.textContent = 'Disconnected. Revoke the token in PrintBench if you no longer need it.'
    if (connection) await browser.permissions.remove(hostPermission(connection.origin))
  })()
    .catch(showError)
    .finally(() => setBusy(false))
})

void showConnection().catch(showError)
