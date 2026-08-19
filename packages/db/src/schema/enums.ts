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

export const printHostProtocol = pgEnum('print_host_protocol', [
  'octoprint',
  'moonraker',
  'prusalink',
])

export const listKind = pgEnum('list_kind', ['normal', 'liked'])
