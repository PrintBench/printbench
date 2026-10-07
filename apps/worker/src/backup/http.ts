import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import {
  BACKUP_FIRST_RUN_SUBJECT,
  SYSTEM_ACTOR,
  recordAudit,
  verifyToken,
  type AuditActor,
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
  error?: string
  startedAt?: string
  finishedAt?: string
}

const FORM_MAX_BYTES = 64 * 1024
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function createBackupHandler(options: BackupHttpOptions) {
  mkdirSync(options.directory, { recursive: true })
  const stateFile = path.join(options.directory, 'restore-state.json')
  const stagedFile = (id: string) =>
    path.join(options.directory, `upload-${id}.${BACKUP_EXTENSION}`)

  /*
   * Kept in a file as well as in memory. It cannot live in the database — that
   * is the thing being replaced — and it has to outlast a worker that is
   * restarted while a browser is still polling.
   */
  let state: RestoreState = loadState()

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

  async function handleUpload(
    request: IncomingMessage,
    response: ServerResponse,
    query: URLSearchParams,
  ): Promise<void> {
    const auth = await authorize('backup-restore', query)
    if (!auth.ok) return json(response, auth.status, { error: auth.error })
    if (state.status === 'restoring') {
      return json(response, 409, { error: 'A restore is already in progress.' })
    }

    // One staged upload at a time; an abandoned one would otherwise sit on
    // the data volume for good.
    for (const name of await readdir(options.directory)) {
      if (name.startsWith('upload-')) await rm(path.join(options.directory, name), { force: true })
    }

    const id = randomUUID()
    const file = stagedFile(id)
    try {
      await pipeline(request, createWriteStream(file))
      const backup = await openBackup(file)
      const summary = summarize(backup.manifest)
      backup.close()

      setState({ status: 'uploaded', id, summary })
      json(response, 200, { id, summary })
    } catch (error) {
      await rm(file, { force: true })
      if (error instanceof BackupError) return json(response, 400, { error: error.message })
      console.error('[backup] upload failed:', error)
      json(response, 500, { error: 'The upload could not be read.' })
    }
  }

  async function handleApply(
    request: IncomingMessage,
    response: ServerResponse,
    query: URLSearchParams,
  ): Promise<void> {
    const auth = await authorize('backup-restore', query)
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

    try {
      await verifyBackupPassphrase(file, passphrase)
    } catch (error) {
      const message = error instanceof BackupError ? error.message : 'The backup could not be read.'
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
    void runRestore(id, file, passphrase, auth.actor)
  }

  async function runRestore(
    id: string,
    file: string,
    passphrase: string | undefined,
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
        passphrase,
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
          credentials: result.secretsRestored,
          thumbnailsQueued: stale.length,
        },
      })
      console.log(
        `[backup] restore finished: ${summary.rows} rows, ${result.filesRestored} files, ` +
          `${stale.length} thumbnails queued`,
      )
      setState({ ...started, status: 'done', summary, finishedAt: new Date().toISOString() })
      await rm(file, { force: true })
    } catch (error) {
      console.error('[backup] restore failed:', error)
      if (paused) {
        await options.resume({ restored }).catch((resumeError: unknown) => {
          console.error('[backup] could not resume jobs after a failed restore:', resumeError)
        })
      }

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
          return await handleUpload(request, response, url.searchParams)
        }
        if (route === 'POST /api/backup/restore/apply') {
          return await handleApply(request, response, url.searchParams)
        }
        if (route === 'GET /api/backup/restore/status') {
          const auth = await authorize('backup-restore', url.searchParams, { live: false })
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
