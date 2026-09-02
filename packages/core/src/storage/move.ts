import { DestinationExistsError, ReadOnlyLibraryError, type StorageAdapter } from './types'

/**
 * Moving a file from one library to another.
 *
 * The backend-agnostic half of a move: which adapter does what, in which
 * order, and what happens when the two have nothing in common. Everything that
 * needs to touch a filesystem or an S3 client lives in the adapters, behind
 * `move` and `adoptFrom`.
 *
 * Ordering is the whole point of this file. A move is a copy and a delete, and
 * the only safe sequence is copy, verify, delete — so that every failure leaves
 * either the original or both, and never neither. Two files where there should
 * be one is a tidy-up; zero files is somebody's model gone.
 */

/** How the bytes got there. Reported so a slow move is explicable. */
export type MoveStrategy =
  /** Renamed or server-side copied — the bytes never moved. */
  | 'direct'
  /** Read out of one library and written into the other, through this process. */
  | 'streamed'

export interface MoveOutcome {
  strategy: MoveStrategy
  from: string
  to: string
}

/**
 * Moves one file between two libraries, or within one.
 *
 * Both libraries must be writable: the destination is written to, and the
 * source has the file taken away from it. That rules out an in-place library
 * that has not opted in, which is the read-only promise doing its job — a
 * model in one of those can only be moved by moving the files by hand.
 */
export async function moveFile(
  source: StorageAdapter,
  destination: StorageAdapter,
  from: string,
  to: string,
): Promise<MoveOutcome> {
  assertWritable(source)
  assertWritable(destination)

  /*
   * Refuse an occupied destination before anything is copied.
   *
   * Racy in principle — nothing stops a file appearing between this check and
   * the write. In practice the two libraries are being scanned by a worker
   * that holds one scan per library at a time, and the alternative to a
   * best-effort check is no check, which turns "you already have a Red Dragon
   * over there" into silently overwriting it.
   */
  if (await destination.stat(to)) throw new DestinationExistsError(to)

  if (source.library.id === destination.library.id) {
    await destination.move(from, to)
    return { strategy: 'direct', from, to }
  }

  // A shared volume or a shared endpoint, where the bytes can stay put. The
  // adapter is the only thing that can tell, and says false when they cannot.
  if (await destination.adoptFrom?.(source, from, to)) {
    return { strategy: 'direct', from, to }
  }

  /*
   * The long way: local disk to a bucket, one provider to another, or an
   * object too large for a single server-side copy. Streamed rather than
   * buffered — `write` does a multipart upload for S3 — so a six-gigabyte
   * mesh costs bandwidth and time but not memory.
   */
  await destination.write(to, await source.createReadStream(from))

  /*
   * Only now. If this throws, the file exists in both libraries and the caller
   * must not record the move — the copy is inert until the index points at it,
   * whereas a source deleted before a confirmed write is unrecoverable.
   */
  await source.remove(from)

  return { strategy: 'streamed', from, to }
}

function assertWritable(adapter: StorageAdapter): void {
  const { kind, allowWrites, id } = adapter.library
  if (kind !== 'managed' && !allowWrites) throw new ReadOnlyLibraryError(id)
}
