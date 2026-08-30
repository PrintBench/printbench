import { sql } from 'drizzle-orm'
import type { Database } from '@pb/db'
import {
  MAX_BULK_REQUESTS,
  MAX_NAME,
  MAX_NOTES,
  MAX_QUANTITY,
  MAX_TITLE,
  REQUEST_PRIORITIES,
  REQUEST_STATUSES,
  type PrintRequestPriority,
  type PrintRequestStatus,
} from './request-lines'

/**
 * The print queue.
 *
 * People ask for prints in batches and in prose — "can you do the dragon, two
 * cable clips and something to hold the kitchen roll" — so the queue is built
 * around that rather than around the library. A request needs nothing but a
 * title; the link to a model is optional, added later if the file turns up.
 *
 * The queue is shared across the instance, unlike lists, which are private. A
 * request is addressed to whoever runs the printer, so a queue only its author
 * could see would be a note to self, not a request.
 */

/*
 * The pure half lives in request-lines.ts so client components can reach it
 * without dragging the database in, and is re-exported here so server callers
 * still have one import for the whole feature.
 */
export * from './request-lines'

/** Closed states. Drives the ordering and when `closed_at` is stamped. */
const CLOSED: readonly PrintRequestStatus[] = ['done', 'cancelled']

export interface RequestInput {
  title: string
  notes?: string | null
  requestedBy?: string | null
  requestedByUserId?: string | null
  modelId?: string | null
  modelFileId?: string | null
  quantity?: number | null
  priority?: PrintRequestPriority | null
  material?: string | null
  colorHex?: string | null
  dueAt?: Date | null
}

export class RequestValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RequestValidationError'
  }
}

export interface PrintRequest {
  id: string
  title: string
  notes: string | null
  requestedBy: string | null
  requestedByUserId: string | null

  modelId: string | null
  /** For linking onward: the model page addresses models by public id. */
  modelPublicId: string | null
  modelName: string | null
  /** Whichever of the model's files has a thumbnail, for the row's image. */
  thumbFileId: string | null
  modelFileId: string | null
  filename: string | null
  /** True when the linked model has since gone missing from disk. */
  modelMissing: boolean

  quantity: number
  priority: PrintRequestPriority
  status: PrintRequestStatus
  material: string | null
  colorHex: string | null

  dueAt: Date | null
  closedAt: Date | null
  createdBy: string | null
  createdByName: string | null
  createdAt: Date
}

export interface QueueStats {
  waiting: number
  printing: number
  done: number
  cancelled: number
  /** Open requests whose due date has passed. */
  overdue: number
}

/* ------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------ */

function cleanTitle(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length === 0) throw new RequestValidationError('A request needs a title.')
  return trimmed.slice(0, MAX_TITLE)
}

function cleanColor(value: string | null | undefined): string | null {
  if (!value) return null
  if (!/^#[0-9a-f]{6}$/i.test(value)) {
    throw new RequestValidationError('Colour must be a hex value like #1a2b3c.')
  }
  return value.toLowerCase()
}

function cleanPriority(value: PrintRequestPriority | null | undefined): PrintRequestPriority {
  if (!value) return 'normal'
  if (!REQUEST_PRIORITIES.includes(value)) {
    throw new RequestValidationError('That is not a priority.')
  }
  return value
}

function cleanStatus(value: PrintRequestStatus): PrintRequestStatus {
  if (!REQUEST_STATUSES.includes(value)) {
    throw new RequestValidationError('That is not a status.')
  }
  return value
}

function cleanQuantity(value: number | null | undefined): number {
  if (value == null) return 1
  if (!Number.isFinite(value) || value < 1) {
    throw new RequestValidationError('Quantity must be at least 1.')
  }
  if (value > MAX_QUANTITY) {
    throw new RequestValidationError(`Quantity cannot be more than ${MAX_QUANTITY}.`)
  }
  return Math.trunc(value)
}

function trimTo(value: string | null | undefined, max: number): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed.slice(0, max) : null
}

/* ------------------------------------------------------------------ *
 * Linking to the library
 * ------------------------------------------------------------------ */

/**
 * The one model this title can only mean, or null.
 *
 * Deliberately an exact, case-insensitive name match and nothing cleverer. A
 * fuzzy match would attach "Dragon" to whichever of eleven dragons ranked
 * highest, and a wrong link is worse than no link — it sends someone to print
 * the wrong thing, and nobody re-checks a field that is already filled in.
 * Anything less certain than this is left to the picker.
 */
export async function findExactModelMatch(db: Database, title: string): Promise<string | null> {
  const trimmed = title.trim()
  if (trimmed.length === 0) return null

  const rows = await db.execute<{ id: string }>(sql`
    SELECT id FROM models
    WHERE missing_at IS NULL AND lower(name) = lower(${trimmed})
    LIMIT 2`)

  // Two matches means the name is ambiguous, so it is not an answer.
  return rows.rows.length === 1 ? rows.rows[0]!.id : null
}

/** Confirms a file belongs to the model it is being filed under. */
async function fileBelongsToModel(
  db: Database,
  modelId: string,
  modelFileId: string,
): Promise<boolean> {
  const rows = await db.execute<{ id: string }>(sql`
    SELECT id FROM model_files WHERE id = ${modelFileId} AND model_id = ${modelId} LIMIT 1`)
  return rows.rows.length > 0
}

/* ------------------------------------------------------------------ *
 * Writes
 * ------------------------------------------------------------------ */

export async function createRequest(
  db: Database,
  input: RequestInput,
  createdBy: string | null,
): Promise<{ id: string; autoLinked: boolean }> {
  const title = cleanTitle(input.title)

  /*
   * Only reach for a match when the caller has not supplied one. Coming from
   * the model page the link is already known, and searching for it again could
   * only ever disagree with the model the user was looking at.
   */
  let modelId = input.modelId ?? null
  let autoLinked = false
  if (modelId == null) {
    modelId = await findExactModelMatch(db, title)
    autoLinked = modelId != null
  }

  const modelFileId = input.modelFileId ?? null
  if (modelFileId && (!modelId || !(await fileBelongsToModel(db, modelId, modelFileId)))) {
    throw new RequestValidationError('That file does not belong to the linked model.')
  }

  const rows = await db.execute<{ id: string }>(sql`
    INSERT INTO print_requests
      (title, notes, requested_by, requested_by_user_id, model_id, model_file_id,
       quantity, priority, material, color_hex, due_at, created_by)
    VALUES (${title}, ${trimTo(input.notes, MAX_NOTES)}, ${trimTo(input.requestedBy, MAX_NAME)},
            ${input.requestedByUserId ?? null}, ${modelId}, ${modelFileId},
            ${cleanQuantity(input.quantity)},
            ${cleanPriority(input.priority)}::print_request_priority,
            ${trimTo(input.material, MAX_NAME)}, ${cleanColor(input.colorHex)},
            ${input.dueAt ?? null}, ${createdBy})
    RETURNING id`)

  return { id: rows.rows[0]!.id, autoLinked }
}

/**
 * Creates a batch in one go, which is the case this feature exists for.
 *
 * Each row is inserted on its own rather than as one multi-row statement:
 * every title needs its own auto-link lookup anyway, and one bad line should
 * not cost the person the other nine.
 */
export async function createRequests(
  db: Database,
  inputs: RequestInput[],
  createdBy: string | null,
): Promise<{ created: number; autoLinked: number; failed: { title: string; error: string }[] }> {
  if (inputs.length === 0) throw new RequestValidationError('Nothing to add.')
  if (inputs.length > MAX_BULK_REQUESTS) {
    throw new RequestValidationError(`Add at most ${MAX_BULK_REQUESTS} requests at a time.`)
  }

  let created = 0
  let autoLinked = 0
  const failed: { title: string; error: string }[] = []

  for (const input of inputs) {
    try {
      const result = await createRequest(db, input, createdBy)
      created += 1
      if (result.autoLinked) autoLinked += 1
    } catch (error) {
      failed.push({
        title: input.title,
        error: error instanceof RequestValidationError ? error.message : 'Could not add this one.',
      })
    }
  }

  return { created, autoLinked, failed }
}

/**
 * A partial edit. Every field is optional and `undefined` means "leave alone",
 * which is what lets a caller change one thing without restating the rest —
 * and is why `null` has to stay meaningful as "clear this".
 */
export type RequestPatch = Partial<
  Pick<
    RequestInput,
    'title' | 'notes' | 'requestedBy' | 'quantity' | 'priority' | 'material' | 'colorHex' | 'dueAt'
  >
>

export async function updateRequest(
  db: Database,
  requestId: string,
  patch: RequestPatch,
): Promise<void> {
  const sets: ReturnType<typeof sql>[] = []

  if (patch.title !== undefined) sets.push(sql`title = ${cleanTitle(patch.title)}`)
  if (patch.notes !== undefined) sets.push(sql`notes = ${trimTo(patch.notes, MAX_NOTES)}`)
  if (patch.requestedBy !== undefined) {
    sets.push(sql`requested_by = ${trimTo(patch.requestedBy, MAX_NAME)}`)
  }
  if (patch.quantity !== undefined) sets.push(sql`quantity = ${cleanQuantity(patch.quantity)}`)
  if (patch.priority !== undefined) {
    sets.push(sql`priority = ${cleanPriority(patch.priority)}::print_request_priority`)
  }
  if (patch.material !== undefined) sets.push(sql`material = ${trimTo(patch.material, MAX_NAME)}`)
  if (patch.colorHex !== undefined) sets.push(sql`color_hex = ${cleanColor(patch.colorHex)}`)
  if (patch.dueAt !== undefined) sets.push(sql`due_at = ${patch.dueAt ?? null}`)

  // Nothing to change is not an error — it is a form submitted untouched.
  if (sets.length === 0) return

  sets.push(sql`updated_at = now()`)
  await db.execute(sql`
    UPDATE print_requests SET ${sql.join(sets, sql`, `)} WHERE id = ${requestId}`)
}

/**
 * Moves a request through the queue.
 *
 * `closed_at` is derived here rather than asked for, so reopening something
 * marked done by mistake clears it again and a row cannot end up claiming to
 * be both open and closed.
 */
export async function setRequestStatus(
  db: Database,
  requestId: string,
  status: PrintRequestStatus,
): Promise<void> {
  const next = cleanStatus(status)
  const closed = CLOSED.includes(next)

  await db.execute(sql`
    UPDATE print_requests
    SET status = ${next}::print_request_status,
        closed_at = ${closed ? sql`coalesce(closed_at, now())` : sql`NULL`},
        updated_at = now()
    WHERE id = ${requestId}`)
}

/** Attaches the request to a model, or clears the link when modelId is null. */
export async function linkRequest(
  db: Database,
  requestId: string,
  modelId: string | null,
  modelFileId: string | null = null,
): Promise<void> {
  if (modelId && modelFileId && !(await fileBelongsToModel(db, modelId, modelFileId))) {
    throw new RequestValidationError('That file does not belong to that model.')
  }

  await db.execute(sql`
    UPDATE print_requests
    SET model_id = ${modelId},
        -- Clearing the model clears the file with it, or the row keeps a file
        -- id that the check constraint would reject on the next write.
        model_file_id = ${modelId ? modelFileId : null},
        updated_at = now()
    WHERE id = ${requestId}`)
}

export async function deleteRequest(db: Database, requestId: string): Promise<void> {
  await db.execute(sql`DELETE FROM print_requests WHERE id = ${requestId}`)
}

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

type Row = {
  id: string
  title: string
  notes: string | null
  requested_by: string | null
  requested_by_user_id: string | null
  model_id: string | null
  model_public_id: string | null
  model_name: string | null
  model_missing: boolean | null
  thumb_file_id: string | null
  model_file_id: string | null
  filename: string | null
  quantity: number
  priority: PrintRequestPriority
  status: PrintRequestStatus
  material: string | null
  color_hex: string | null
  due_at: string | null
  closed_at: string | null
  created_by: string | null
  created_by_name: string | null
  created_at: string
}

const SELECT_REQUEST = sql`
  SELECT r.id, r.title, r.notes, r.requested_by, r.requested_by_user_id,
         r.model_id, m.public_id AS model_public_id, m.name AS model_name,
         (m.missing_at IS NOT NULL) AS model_missing,
         (SELECT f.id FROM model_files f
           WHERE f.model_id = m.id AND f.thumb_state = 'ok' AND f.missing_at IS NULL
           ORDER BY f.size DESC LIMIT 1) AS thumb_file_id,
         r.model_file_id, mf.filename,
         r.quantity, r.priority, r.status, r.material, r.color_hex,
         r.due_at, r.closed_at, r.created_by, u.name AS created_by_name, r.created_at
  FROM print_requests r
  LEFT JOIN models m ON m.id = r.model_id
  LEFT JOIN model_files mf ON mf.id = r.model_file_id
  LEFT JOIN "user" u ON u.id = r.created_by`

function toRequest(row: Row): PrintRequest {
  return {
    id: row.id,
    title: row.title,
    notes: row.notes,
    requestedBy: row.requested_by,
    requestedByUserId: row.requested_by_user_id,
    modelId: row.model_id,
    modelPublicId: row.model_public_id,
    modelName: row.model_name,
    thumbFileId: row.thumb_file_id,
    modelFileId: row.model_file_id,
    filename: row.filename,
    modelMissing: row.model_missing === true,
    quantity: row.quantity,
    priority: row.priority,
    status: row.status,
    material: row.material,
    colorHex: row.color_hex,
    dueAt: row.due_at ? new Date(row.due_at) : null,
    closedAt: row.closed_at ? new Date(row.closed_at) : null,
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    createdAt: new Date(row.created_at),
  }
}

export async function getRequest(db: Database, requestId: string): Promise<PrintRequest | null> {
  const rows = await db.execute<Row>(sql`${SELECT_REQUEST} WHERE r.id = ${requestId} LIMIT 1`)
  return rows.rows[0] ? toRequest(rows.rows[0]) : null
}

export async function listRequests(
  db: Database,
  options: {
    /** Empty or absent means every status. */
    status?: PrintRequestStatus[]
    modelId?: string
    limit?: number
    offset?: number
  } = {},
): Promise<PrintRequest[]> {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 200)

  const conditions = [
    /*
     * sql.param() rather than a bare array: Drizzle spreads a plain array into
     * separate placeholders, turning `= ANY($1)` into `= ANY($1,$2)`.
     */
    options.status?.length
      ? sql`r.status = ANY(${sql.param(options.status)}::print_request_status[])`
      : null,
    options.modelId ? sql`r.model_id = ${options.modelId}` : null,
  ].filter(Boolean) as ReturnType<typeof sql>[]

  const where = conditions.length > 0 ? sql`WHERE ${sql.join(conditions, sql` AND `)}` : sql``

  /*
   * Two orderings, because the two halves of the queue are read for different
   * reasons. An open list is a work queue — most urgent first, and among
   * equals whatever has been waiting longest. A closed list is a record, and a
   * record is read newest first.
   */
  const closedOnly =
    options.status != null &&
    options.status.length > 0 &&
    options.status.every((status) => CLOSED.includes(status))

  const order = closedOnly
    ? sql`ORDER BY r.closed_at DESC NULLS LAST, r.created_at DESC`
    : sql`ORDER BY (r.status IN ('done', 'cancelled')) ASC,
                   r.priority DESC,
                   r.due_at ASC NULLS LAST,
                   r.created_at ASC`

  const rows = await db.execute<Row>(sql`
    ${SELECT_REQUEST}
    ${where}
    ${order}
    LIMIT ${limit} OFFSET ${Math.max(options.offset ?? 0, 0)}`)

  return rows.rows.map(toRequest)
}

/** Open requests against one model, for the "someone is waiting for this" note. */
export async function openRequestsForModel(db: Database, modelId: string): Promise<PrintRequest[]> {
  return listRequests(db, { modelId, status: ['requested', 'printing'], limit: 20 })
}

export async function queueStats(db: Database): Promise<QueueStats> {
  const result = await db.execute<{
    waiting: number
    printing: number
    done: number
    cancelled: number
    overdue: number
  }>(sql`
    SELECT count(*) FILTER (WHERE status = 'requested')::int AS waiting,
           count(*) FILTER (WHERE status = 'printing')::int  AS printing,
           count(*) FILTER (WHERE status = 'done')::int      AS done,
           count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
           count(*) FILTER (
             WHERE status IN ('requested', 'printing') AND due_at IS NOT NULL AND due_at < now()
           )::int AS overdue
    FROM print_requests`)

  const row = result.rows[0]
  return {
    waiting: row?.waiting ?? 0,
    printing: row?.printing ?? 0,
    done: row?.done ?? 0,
    cancelled: row?.cancelled ?? 0,
    overdue: row?.overdue ?? 0,
  }
}

/** Names already used, so the "requested by" field can suggest rather than ask. */
export async function requesterSuggestions(db: Database): Promise<string[]> {
  const rows = await db.execute<{ value: string }>(sql`
    SELECT requested_by AS value FROM print_requests WHERE requested_by IS NOT NULL
    GROUP BY requested_by ORDER BY count(*) DESC, requested_by ASC LIMIT 30`)
  return rows.rows.map((row) => row.value)
}
