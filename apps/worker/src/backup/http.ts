import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import {
  createReadStream,
  createWriteStream,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { open as openFile, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import {
  BACKUP_FIRST_RUN_SUBJECT,
  BACKUP_TICKET_HEADER,
  EnvelopeError,
  HEADER_PROBE_BYTES,
  SYSTEM_ACTOR,
  backupLocation,
  createStorageAdapter,
  describeS3Error,
  isEncryptedBackup,
  parseBackupPath,
  parseEnvelopeHeader,
  recordAudit,
  unlockEnvelope,
  verifyToken,
  type AuditActor,
  type ParsedHeader,
  type TokenPurpose,
} from '@pb/core'
import { getDb, getPool } from '@pb/db'
import { JOB, getQueue } from '@pb/jobs'
import { writeBackup } from './export'
import { BACKUP_EXTENSION, BackupError, summarize, type BackupSummary } from './manifest'
import {
  markMissingPreviews,
  openBackup,
  restoreBackup,
  verifyBackupPassphrase,
  type RestorePhase,
  type SecretsUnlock,
} from './restore'

/**
 * The HTTP side of backup and restore.
 *
 * Served by the worker for the same reason ZIP downloads are: an archive of a
 * whole instance can run to many gigabytes and take minutes, and the process
 * that renders pages should not be the one holding it.
 *
 * The worker has no sessions. The web tier decides who may do this and hands
 * over a signed, short-lived token naming them; every route here verifies it.
 * The restore ticket arrives in a header; the export's arrives in its form body.
 * A restore is three calls — upload, apply, then status polled until it is
 * done — because the database the browser's session lives in is replaced
 * half-way through, and a single long request could not report what happened.
 */

export interface BackupHttpOptions {
  /** Where uploaded backups are staged and the restore state is kept. */
  directory: string
  appVersion?: string
  /** Stops job handlers and watchers, returning once running work has drained. */
  pause(): Promise<void>
  /** Starts them again. `restored` means the database underneath was replaced. */
  resume(context: { restored: boolean }): Promise<void>
}

export interface RestoreState {
  status: 'idle' | 'uploaded' | 'restoring' | 'done' | 'failed'
  id?: string
  phase?: RestorePhase
  summary?: BackupSummary
  /** An encrypted backup not yet unlocked: only its plaintext header is known. */
  locked?: LockedSummary
  /** Came from an encrypted file, so its passphrase is needed again to apply it. */
  encrypted?: boolean
  error?: string
  startedAt?: string
  finishedAt?: string
}

/** What an encrypted backup says about itself before its passphrase is given. */
export interface LockedSummary {
  createdAt: string
  appVersion: string | null
  keyId: string
}

const FORM_MAX_BYTES = 64 * 1024
/*
 * A staged backup is the whole instance's data, and once unlocked it is
 * plaintext. Cancelling discards it at once; this is the backstop for a tab
 * that was simply closed. Measured from the file's last write, so an upload
 * still arriving is never swept from under itself.
 */
const STAGED_TTL_MS = 60 * 60 * 1000
const STAGED_SWEEP_MS = 10 * 60 * 1000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function createBackupHandler(options: BackupHttpOptions) {
  mkdirSync(options.directory, { recursive: true })
  const stateFile = path.join(options.directory, 'restore-state.json')
  const stagedFile = (id: string) =>
    path.join(options.directory, `upload-${id}.${BACKUP_EXTENSION}`)
  /*
   * An encrypted backup is staged as it arrived, then decrypted into
   * stagedFile once its passphrase is given — the ZIP inside needs random
   * access, which a stream of sealed chunks cannot give it. Its header is
   * kept beside the decrypted copy, because applying the restore unlocks the
   * credentials inside with a key only the header and passphrase can produce.
   */
  const encryptedFile = (id: string) => path.join(options.directory, `upload-${id}.encrypted`)
  const envelopeFile = (id: string) => path.join(options.directory, `upload-${id}.envelope`)

  /*
   * Kept in a file as well as in memory. It cannot live in the database — that
   * is the thing being replaced — and it has to outlast a worker that is
   * restarted while a browser is still polling.
   */
  let state: RestoreState = loadState()

  /*
   * A restore the worker never finished cannot be retried from its staged
   * file — the browser has gone back to the start — so nothing is kept for
   * it. Anything else is left to the sweep's age limit, since a browser may
   * still be part-way through reviewing it.
   */
  if (state.status === 'failed' && state.id) void removeStagedFiles(state.id)
  void sweepStaged()
  setInterval(() => void sweepStaged(), STAGED_SWEEP_MS).unref()

  function loadState(): RestoreState {
    try {
      const saved = JSON.parse(readFileSync(stateFile, 'utf8')) as RestoreState
      if (saved.status !== 'restoring') return saved
      // The load runs in one transaction, so an interrupted one rolled back.
      return {
        ...saved,
        status: 'failed',
        finishedAt: new Date().toISOString(),
        error:
          'The restore was interrupted because the worker restarted. If it had not finished, nothing was changed.',
      }
    } catch {
      return { status: 'idle' }
    }
  }

  function setState(next: RestoreState): void {
    state = next
    try {
      writeFileSync(stateFile, JSON.stringify(next))
    } catch (error) {
      console.warn(`[backup] could not save restore state: ${String(error)}`)
    }
  }

  /** Verifies the signature, then that whoever it names may still do this. */
  async function authorize(
    purpose: TokenPurpose,
    fields: URLSearchParams,
    { live = true } = {},
  ): Promise<{ ok: true; actor: AuditActor } | { ok: false; status: number; error: string }> {
    const secret = process.env.BETTER_AUTH_SECRET
    if (!secret) return { ok: false, status: 500, error: 'Backups are not configured.' }

    const subject = fields.get('subject') ?? ''
    const signed = verifyToken(
      secret,
      purpose,
      subject,
      fields.get('token'),
      Number(fields.get('expires') ?? 0),
    )
    if (!signed) return { ok: false, status: 403, error: 'This link has expired. Start again.' }
    // Status is polled after the database, and the account in it, has gone.
    if (!live) return { ok: true, actor: SYSTEM_ACTOR }

    const pool = getPool()
    if (subject === BACKUP_FIRST_RUN_SUBJECT) {
      /*
       * The first-run restore needs no account, because there are none. It
       * closes the moment one exists, exactly as the setup page does — checked
       * here and not only where the token was issued.
       */
      const users = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM "user"')
      if ((users.rows[0]?.n ?? 0) > 0) {
        return { ok: false, status: 403, error: 'Setup has already been completed.' }
      }
      return { ok: true, actor: { type: 'anonymous', name: 'First-run setup' } }
    }

    const userId = subject.startsWith('user:') ? subject.slice('user:'.length) : ''
    const found = await pool.query<{ name: string; role: string | null; banned: boolean | null }>(
      'SELECT name, role, banned FROM "user" WHERE id = $1',
      [userId],
    )
    const user = found.rows[0]
    if (!user || user.role !== 'admin' || user.banned) {
      return { ok: false, status: 403, error: 'Not permitted.' }
    }
    return { ok: true, actor: { type: 'user', id: userId, name: user.name } }
  }

  async function handleExport(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // A form post rather than a link, so the passphrase travels in the body
    // and never appears in a URL, a log line or the browser's history.
    const fields = new URLSearchParams(await readBody(request, FORM_MAX_BYTES))
    const auth = await authorize('backup-export', fields)
    if (!auth.ok) return text(response, auth.status, auth.error)
    if (state.status === 'restoring') {
      return text(response, 409, 'A restore is in progress. Try again when it has finished.')
    }

    const includeFiles = fields.get('includeFiles') === 'on'
    const passphrase = fields.get('passphrase') || undefined

    response.writeHead(200, {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="printbench-backup-${fileStamp()}.${BACKUP_EXTENSION}"`,
      'cache-control': 'no-store',
    })

    const abort = new AbortController()
    request.on('close', () => {
      if (!response.writableEnded) abort.abort()
    })

    try {
      const manifest = await writeBackup({
        pool: getPool(),
        output: response,
        includeFiles,
        passphrase,
        appVersion: options.appVersion,
        signal: abort.signal,
      })
      const summary = summarize(manifest)
      await recordAudit(getDb(), {
        action: 'backup.exported',
        actor: auth.actor,
        detail: {
          rows: summary.rows,
          files: summary.files.included ? summary.files.count : 'not included',
          photos: summary.photos.count,
          credentials: summary.hasSecrets ? summary.secretCount : 'not included',
        },
      })
      console.log(`[backup] exported ${summary.rows} rows and ${summary.files.count} files`)
    } catch (error) {
      if (!abort.signal.aborted) console.error('[backup] export failed:', error)
      // The headers have gone; all that is left is to cut the download short
      // so the browser does not present a truncated file as complete.
      response.destroy()
    }
  }

  async function handleUpload(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const auth = await authorize('backup-restore', ticketFrom(request))
    if (!auth.ok) return json(response, auth.status, { error: auth.error })
    if (state.status === 'restoring') {
      return json(response, 409, { error: 'A restore is already in progress.' })
    }

    // One staged upload at a time; an abandoned one would otherwise sit on
    // the data volume for good.
    await clearStaged()

    const id = randomUUID()
    const file = stagedFile(id)
    try {
      await pipeline(request, createWriteStream(file))
      const probe = await readStart(file)
      if (isEncryptedBackup(probe)) {
        const locked = lockedSummary(parseEnvelopeHeader(probe))
        await rename(file, encryptedFile(id))
        setState({ status: 'uploaded', id, locked, encrypted: true })
        return json(response, 200, { id, locked })
      }

      const backup = await openBackup(file)
      const summary = summarize(backup.manifest)
      backup.close()

      setState({ status: 'uploaded', id, summary })
      json(response, 200, { id, summary })
    } catch (error) {
      await rm(file, { force: true })
      if (error instanceof BackupError || error instanceof EnvelopeError) {
        return json(response, 400, { error: error.message })
      }
      console.error('[backup] upload failed:', error)
      json(response, 500, { error: 'The upload could not be read.' })
    }
  }

  /** Removes any staged upload, so only one ever sits on the data volume. */
  async function clearStaged(): Promise<void> {
    for (const name of await readdir(options.directory)) {
      if (name.startsWith('upload-')) await rm(path.join(options.directory, name), { force: true })
    }
  }

  /** Every file staged for one upload: as uploaded, decrypted, and its header. */
  async function removeStagedFiles(id: string): Promise<void> {
    for (const file of [stagedFile(id), encryptedFile(id), envelopeFile(id)]) {
      await rm(file, { force: true }).catch((error: unknown) => {
        console.warn(`[backup] could not remove ${path.basename(file)}: ${String(error)}`)
      })
    }
  }

  /** Forgets a staged upload, leaving nothing of it behind. */
  async function discardStaged(id: string): Promise<void> {
    await removeStagedFiles(id)
    if (state.status === 'uploaded' && state.id === id) setState({ status: 'idle' })
  }

  /** Removes staged uploads nobody has touched for STAGED_TTL_MS. */
  async function sweepStaged(): Promise<void> {
    if (state.status === 'restoring') return
    try {
      const now = Date.now()
      for (const name of await readdir(options.directory)) {
        if (!name.startsWith('upload-')) continue
        const file = path.join(options.directory, name)
        const info = await stat(file).catch(() => null)
        if (info && now - info.mtimeMs > STAGED_TTL_MS) {
          await rm(file, { force: true })
          console.log(`[backup] removed an abandoned restore upload (${name})`)
        }
      }
      if (state.status === 'uploaded' && state.id) {
        const left = await Promise.all(
          [stagedFile(state.id), encryptedFile(state.id)].map((file) =>
            stat(file).catch(() => null),
          ),
        )
        if (left.every((info) => info === null)) setState({ status: 'idle' })
      }
    } catch (error) {
      console.warn(`[backup] could not sweep staged uploads: ${String(error)}`)
    }
  }

  /** The person changed their mind: back out everything this restore staged. */
  async function handleDiscard(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const auth = await authorize('backup-restore', ticketFrom(request))
    if (!auth.ok) return json(response, auth.status, { error: auth.error })
    if (state.status === 'restoring') {
      return json(response, 409, { error: 'A restore is in progress and cannot be cancelled.' })
    }
    let body: { id?: unknown }
    try {
      body = JSON.parse(await readBody(request, FORM_MAX_BYTES)) as typeof body
    } catch {
      return json(response, 400, { error: 'Malformed request.' })
    }
    const id = typeof body.id === 'string' && UUID.test(body.id) ? body.id : ''
    if (!id) return json(response, 400, { error: 'Malformed request.' })
    await discardStaged(id)
    json(response, 200, { ok: true })
  }

  /**
   * Copies a backup from the schedule's bucket into staging, as if it had
   * been uploaded. Only names the schedule writes are accepted, so this cannot
   * be pointed at anything else in the bucket.
   */
  async function handleFetch(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const auth = await authorize('backup-restore', ticketFrom(request))
    if (!auth.ok) return json(response, auth.status, { error: auth.error })
    if (state.status === 'restoring') {
      return json(response, 409, { error: 'A restore is already in progress.' })
    }

    let body: { path?: unknown }
    try {
      body = JSON.parse(await readBody(request, FORM_MAX_BYTES)) as typeof body
    } catch {
      return json(response, 400, { error: 'Malformed request.' })
    }
    const wanted = typeof body.path === 'string' ? parseBackupPath(body.path) : null
    if (!wanted) return json(response, 400, { error: 'That is not a backup PrintBench wrote.' })
    const name = `${wanted.instanceId}/${wanted.name}`

    const location = await backupLocation(getDb())
    if (!location.ok) return json(response, 400, { error: location.error })

    await clearStaged()
    const id = randomUUID()
    const file = encryptedFile(id)
    const storage = createStorageAdapter(location.data)
    try {
      await pipeline(await storage.createReadStream(name), createWriteStream(file))
      const locked = lockedSummary(parseEnvelopeHeader(await readStart(file)))
      setState({ status: 'uploaded', id, locked, encrypted: true })
      json(response, 200, { id, locked })
    } catch (error) {
      await rm(file, { force: true })
      if (error instanceof EnvelopeError) return json(response, 400, { error: error.message })
      console.error('[backup] fetching from the bucket failed:', error)
      json(response, 502, { error: describeS3Error(error, location.data.s3Bucket ?? '') })
    } finally {
      ;(storage as { destroy?: () => void }).destroy?.()
    }
  }

  /** Decrypts a staged encrypted backup with its passphrase, then reads it like any other. */
  async function handleUnlock(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const auth = await authorize('backup-restore', ticketFrom(request))
    if (!auth.ok) return json(response, auth.status, { error: auth.error })
    if (state.status === 'restoring') {
      return json(response, 409, { error: 'A restore is already in progress.' })
    }

    let body: { id?: unknown; passphrase?: unknown }
    try {
      body = JSON.parse(await readBody(request, FORM_MAX_BYTES)) as typeof body
    } catch {
      return json(response, 400, { error: 'Malformed request.' })
    }
    const id = typeof body.id === 'string' && UUID.test(body.id) ? body.id : ''
    const passphrase = typeof body.passphrase === 'string' ? body.passphrase : ''
    const source = encryptedFile(id)
    if (!id || !(await stat(source).catch(() => null))) {
      return json(response, 404, { error: 'That upload is no longer here. Start again.' })
    }

    const target = stagedFile(id)
    try {
      const probe = await readStart(source)
      const parsed = parseEnvelopeHeader(probe)
      const unlocked = unlockEnvelope(parsed, passphrase)
      if (!unlocked)
        return json(response, 400, { error: 'That passphrase does not open this backup.' })

      await pipeline(
        createReadStream(source, { start: parsed.bodyOffset }),
        unlocked.decrypt(),
        createWriteStream(target),
      )
      const backup = await openBackup(target)
      const summary = summarize(backup.manifest)
      backup.close()

      await writeFile(envelopeFile(id), probe.subarray(0, parsed.bodyOffset))
      await rm(source, { force: true })
      setState({ status: 'uploaded', id, summary, encrypted: true })
      json(response, 200, { id, summary })
    } catch (error) {
      await rm(target, { force: true })
      if (error instanceof BackupError || error instanceof EnvelopeError) {
        return json(response, 400, { error: error.message })
      }
      console.error('[backup] unlocking failed:', error)
      json(response, 500, { error: 'The backup could not be decrypted.' })
    }
  }

  /** The key for the credentials inside a decrypted backup, or null for a wrong passphrase. */
  async function secretsKeyFor(id: string, passphrase: string): Promise<Buffer | null | undefined> {
    const saved = await readFile(envelopeFile(id)).catch(() => null)
    if (!saved) return undefined
    return unlockEnvelope(parseEnvelopeHeader(saved), passphrase)?.secretsKey ?? null
  }

  async function handleApply(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const auth = await authorize('backup-restore', ticketFrom(request))
    if (!auth.ok) return json(response, auth.status, { error: auth.error })
    if (state.status === 'restoring') {
      return json(response, 409, { error: 'A restore is already in progress.' })
    }

    let body: { id?: unknown; passphrase?: unknown }
    try {
      body = JSON.parse(await readBody(request, FORM_MAX_BYTES)) as typeof body
    } catch {
      return json(response, 400, { error: 'Malformed request.' })
    }
    const id = typeof body.id === 'string' && UUID.test(body.id) ? body.id : ''
    const passphrase =
      typeof body.passphrase === 'string' && body.passphrase ? body.passphrase : undefined

    const file = stagedFile(id)
    if (!id || !(await stat(file).catch(() => null))) {
      return json(response, 404, { error: 'That upload is no longer here. Upload the file again.' })
    }

    let unlock: SecretsUnlock
    try {
      const secretsKey = await secretsKeyFor(id, passphrase ?? '')
      if (secretsKey === null) {
        return json(response, 400, { error: 'That passphrase does not open this backup.' })
      }
      unlock = secretsKey ? { key: secretsKey } : { passphrase }
      await verifyBackupPassphrase(file, unlock)
    } catch (error) {
      const message =
        error instanceof BackupError || error instanceof EnvelopeError
          ? error.message
          : 'The backup could not be read.'
      return json(response, 400, { error: message })
    }

    const summary = state.id === id ? state.summary : undefined
    setState({
      status: 'restoring',
      id,
      phase: 'checking',
      summary,
      startedAt: new Date().toISOString(),
    })
    json(response, 202, { ok: true })

    // Deliberately not awaited: the browser follows along by polling status.
    void runRestore(id, file, unlock, auth.actor)
  }

  async function runRestore(
    id: string,
    file: string,
    unlock: SecretsUnlock,
    actor: AuditActor,
  ): Promise<void> {
    const started = { ...state }
    let paused = false
    let restored = false
    try {
      console.log('[backup] restore starting; pausing jobs')
      await options.pause()
      paused = true

      const result = await restoreBackup({
        pool: getPool(),
        file,
        passphrase: unlock.passphrase,
        secretsKey: unlock.key,
        onPhase: (phase) => setState({ ...started, phase }),
      })
      restored = true

      const stale = await markMissingPreviews(getPool())
      await options.resume({ restored: true })
      paused = false
      if (stale.length > 0) {
        await getQueue().sendMany(
          JOB.fileThumbnail,
          stale.map((fileId) => ({ fileId })),
        )
      }

      const summary = summarize(result.manifest)
      // Written to the restored database, so the trail there records how it
      // came to hold what it does.
      await recordAudit(getDb(), {
        action: 'backup.restored',
        actor,
        detail: {
          backupFrom: summary.createdAt,
          backupVersion: summary.appVersion,
          rows: summary.rows,
          files: result.filesRestored,
          photos: result.photosRestored,
          credentials: result.secretsRestored,
          thumbnailsQueued: stale.length,
        },
      })
      console.log(
        `[backup] restore finished: ${summary.rows} rows, ${result.filesRestored} files, ` +
          `${result.photosRestored} photos, ${stale.length} thumbnails queued`,
      )
      setState({ ...started, status: 'done', summary, finishedAt: new Date().toISOString() })
      await removeStagedFiles(id)
    } catch (error) {
      console.error('[backup] restore failed:', error)
      if (paused) {
        await options.resume({ restored }).catch((resumeError: unknown) => {
          console.error('[backup] could not resume jobs after a failed restore:', resumeError)
        })
      }

      // Back to the start, with nothing of this attempt left on disk.
      await removeStagedFiles(id)

      const message = describeFailure(error, restored)
      await recordAudit(getDb(), {
        action: 'backup.restore_failed',
        actor,
        outcome: 'failure',
        detail: { error: message },
      })
      setState({
        ...started,
        status: 'failed',
        error: message,
        finishedAt: new Date().toISOString(),
      })
    }
  }

  return {
    /** True while the database is being replaced; other writers should hold off. */
    isRestoring: () => state.status === 'restoring',

    async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
      const url = new URL(request.url ?? '/', 'http://localhost')
      const route = `${request.method} ${url.pathname}`

      try {
        if (route === 'POST /api/backup/export') return await handleExport(request, response)
        if (route === 'POST /api/backup/restore/upload') {
          return await handleUpload(request, response)
        }
        if (route === 'POST /api/backup/restore/fetch') return await handleFetch(request, response)
        if (route === 'POST /api/backup/restore/discard') {
          return await handleDiscard(request, response)
        }
        if (route === 'POST /api/backup/restore/unlock') {
          return await handleUnlock(request, response)
        }
        if (route === 'POST /api/backup/restore/apply') {
          return await handleApply(request, response)
        }
        if (route === 'GET /api/backup/restore/status') {
          const auth = await authorize('backup-restore', ticketFrom(request), { live: false })
          if (!auth.ok) return json(response, auth.status, { error: auth.error })
          return json(response, 200, state)
        }
        json(response, 404, { error: 'not found' })
      } catch (error) {
        console.error('[backup] unhandled failure:', error)
        if (!response.headersSent) json(response, 500, { error: 'Something went wrong.' })
        else response.destroy()
      }
    },
  }
}

/**
 * The restore ticket, from its header.
 *
 * A header rather than the query string because the ticket is good for hours
 * and URLs are what proxies write to their access logs.
 */
function ticketFrom(request: IncomingMessage): URLSearchParams {
  const header = request.headers[BACKUP_TICKET_HEADER]
  return new URLSearchParams(typeof header === 'string' ? header : '')
}

function describeFailure(error: unknown, restored: boolean): string {
  if (error instanceof BackupError) return error.message
  if (restored) {
    return 'The backup was restored, but PrintBench could not finish tidying up afterwards. Restart it to be safe.'
  }
  // 55P03: lock_not_available. Something held a table for the whole timeout.
  if ((error as { code?: string }).code === '55P03') {
    return 'The database was busy and the restore could not start. Nothing was changed; try again in a moment.'
  }
  return 'The restore failed and nothing was changed. The worker log has the details.'
}

async function readBody(request: IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > limit) throw new BackupError('Request too large.')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  response.end(JSON.stringify(body))
}

function text(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
  response.end(body)
}

/** A filename-safe timestamp: 2026-10-07T14-03-09Z. */
function fileStamp(): string {
  return new Date()
    .toISOString()
    .replace(/\.\d+Z$/, 'Z')
    .replace(/:/g, '-')
}

/** The first bytes of a staged file: enough to tell what it is and hold any header. */
async function readStart(file: string): Promise<Buffer> {
  const handle = await openFile(file, 'r')
  try {
    const buffer = Buffer.alloc(HEADER_PROBE_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

function lockedSummary(parsed: ParsedHeader): LockedSummary {
  const { createdAt, appVersion, keyId } = parsed.header
  return { createdAt, appVersion, keyId }
}
