import { pgEnum } from 'drizzle-orm/pg-core'

/** Where a library's bytes live. A NAS/SMB/NFS mount is just a local path. */
export const storageBackend = pgEnum('storage_backend', ['local', 's3'])

/**
 * `in_place` libraries are the user's own directories and are read-only: we
 * index them, we never move or rename anything in them. `managed` libraries
 * are owned by the app and receive web uploads.
 */
export const libraryKind = pgEnum('library_kind', ['in_place', 'managed'])

/** How a directory tree is carved into models. See packages/core/grouping.ts. */
export const groupingMode = pgEnum('grouping_mode', ['deepest', 'top_level', 'flat'])

export const fileCategory = pgEnum('file_category', [
  'model',
  'image',
  'archive',
  'document',
  'slicer',
  'video',
  'other',
])

/** Lifecycle of a derived artefact (thumbnail, geometry analysis). */
export const derivedState = pgEnum('derived_state', ['pending', 'ok', 'failed', 'skipped'])

export const scanStatus = pgEnum('scan_status', [
  'queued',
  'running',
  'succeeded',
  'failed',
  'aborted',
])

export const scanMode = pgEnum('scan_mode', ['fast', 'deep'])

export const problemKind = pgEnum('problem_kind', [
  'missing',
  'empty',
  'duplicate_digest',
  'no_license',
  'no_creator',
  'no_image',
  'no_tags',
  'nested_model',
  'unparseable',
])

export const problemSeverity = pgEnum('problem_severity', ['info', 'warning', 'danger'])

export const printStatus = pgEnum('print_status', ['in_progress', 'success', 'partial', 'failed'])

/**
 * What the nozzle is made of.
 *
 * Not the same question as its diameter, and the one people actually get wrong:
 * an abrasive filament through a brass nozzle is the difference between a good
 * print and a ruined hot end. `other` exists so an unusual nozzle is still
 * recordable rather than silently dropped.
 */
export const nozzleType = pgEnum('nozzle_type', [
  'brass',
  'hardened_steel',
  'ruby',
  'tungsten_carbide',
  'other',
])

/** First-layer adhesion aid. `none` is a real answer, distinct from unknown. */
export const bedAdhesion = pgEnum('bed_adhesion', ['none', 'skirt', 'brim', 'raft'])

export const printHostProtocol = pgEnum('print_host_protocol', [
  'octoprint',
  'moonraker',
  'prusalink',
])

export const listKind = pgEnum('list_kind', ['normal', 'liked'])

/**
 * Lifecycle of a requested print.
 *
 * Deliberately four states, not five: "someone asked" and "I agreed to do it"
 * collapse into `requested`, because the difference is already carried by who
 * can act — a viewer raises requests, a member is the one who starts them.
 */
export const printRequestStatus = pgEnum('print_request_status', [
  'requested',
  'printing',
  'done',
  'cancelled',
])

/** Declaration order is the sort order, so `ORDER BY priority DESC` is urgent-first. */
export const printRequestPriority = pgEnum('print_request_priority', ['low', 'normal', 'high'])
