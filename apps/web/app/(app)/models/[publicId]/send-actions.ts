'use server'

import { eq } from 'drizzle-orm'
import {
  LocalAdapter,
  PolicyError,
  assertCan,
  canSendToPrinter,
  decryptSecret,
  sendToPrinter,
  type LibraryLocation,
} from '@pm/core'
import { requireUser } from '@pm/auth'
import { getDb, schema } from '@pm/db'

type SendResult = { ok: true; message: string } | { ok: false; error: string }

/**
 * A sliced file is tens of megabytes at worst. Anything larger is not gcode,
 * and buffering it to push at a Raspberry Pi would be a mistake in both places.
 */
const MAX_SEND_BYTES = 256 * 1024 * 1024

/** Printers reachable from this instance, for the send menu. */
export async function listPrintHosts(): Promise<{ id: string; name: string }[]> {
  try {
    const user = await requireUser()
    assertCan(
      { id: user.id, role: user.role ?? null, banned: user.banned ?? false },
      'printhost:send',
    )
  } catch {
    return []
  }

  const rows = await getDb()
    .select({ id: schema.printHosts.id, name: schema.printHosts.name })
    .from(schema.printHosts)
    .orderBy(schema.printHosts.name)

  return rows
}

/**
 * Uploads one sliced file to a configured printer, optionally starting it.
 *
 * Done here rather than on the job queue, deliberately. The transfer is small
 * and quick, and the answers that matter — wrong API key, printer already
 * printing, host switched off — are only useful if the person who pressed the
 * button sees them. Queued, they would land in a log nobody reads.
 */
export async function sendFileToPrinter(
  fileId: string,
  hostId: string,
  startPrint: boolean,
): Promise<SendResult> {
  try {
    const user = await requireUser()
    assertCan(
      { id: user.id, role: user.role ?? null, banned: user.banned ?? false },
      'printhost:send',
    )

    const db = getDb()

    const hostRows = await db
      .select()
      .from(schema.printHosts)
      .where(eq(schema.printHosts.id, hostId))
      .limit(1)

    const host = hostRows[0]
    if (!host) return { ok: false, error: 'That printer is no longer configured.' }

    const rows = await db
      .select({ file: schema.modelFiles, model: schema.models, library: schema.libraries })
      .from(schema.modelFiles)
      .innerJoin(schema.models, eq(schema.models.id, schema.modelFiles.modelId))
      .innerJoin(schema.libraries, eq(schema.libraries.id, schema.models.libraryId))
      .where(eq(schema.modelFiles.id, fileId))
      .limit(1)

    const row = rows[0]
    if (!row || row.file.missingAt) return { ok: false, error: 'That file is no longer on disk.' }
    if (row.library.backend !== 'local') {
      return { ok: false, error: 'Sending is only supported for local libraries so far.' }
    }
    if (!canSendToPrinter(row.file.extension)) {
      return {
        ok: false,
        error: 'Only sliced files can be sent. Open the mesh in a slicer first.',
      }
    }

    const location: LibraryLocation = {
      id: row.library.id,
      kind: row.library.kind,
      backend: row.library.backend,
      allowWrites: row.library.allowWrites,
      path: row.library.path,
    }
    const storage = new LocalAdapter(location)

    // A model that is a single loose file has no folder of its own.
    const relativePath = row.model.isFileModel
      ? row.model.path
      : `${row.model.path}/${row.file.filename}`

    const info = await storage.stat(relativePath).catch(() => null)
    if (!info) return { ok: false, error: 'That file is no longer on disk.' }
    if (info.size > MAX_SEND_BYTES) {
      return { ok: false, error: 'That file is too large to send to a printer.' }
    }

    const data = await readAll(storage, relativePath)
    const filename = row.file.filename.split('/').pop() ?? 'print.gcode'

    const result = await sendToPrinter(
      {
        id: host.id,
        name: host.name,
        protocol: host.protocol,
        endpoint: host.endpoint,
        apiKey: decryptSecret(host.credentials),
      },
      { filename, data },
      { startPrint },
    )

    if (!result.ok) return { ok: false, error: result.error ?? 'The printer refused the file.' }

    return {
      ok: true,
      message: startPrint
        ? `Sent to ${host.name} and started.`
        : `Sent to ${host.name}. Start it from the printer.`,
    }
  } catch (error) {
    if (error instanceof PolicyError) return { ok: false, error: 'Not permitted.' }
    return { ok: false, error: 'Could not send the file.' }
  }
}

async function readAll(
  storage: LocalAdapter,
  relativePath: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const chunks: Buffer[] = []
  for await (const chunk of await storage.createReadStream(relativePath)) {
    chunks.push(chunk as Buffer)
  }

  /*
   * Copied into a plain ArrayBuffer rather than handed over as-is. A Buffer is
   * a view onto Node's shared allocation pool, so its bytes are not necessarily
   * the whole buffer — and its type admits SharedArrayBuffer, which fetch will
   * not take as a body.
   */
  const joined = Buffer.concat(chunks)
  const copy = new Uint8Array(new ArrayBuffer(joined.byteLength))
  copy.set(joined)
  return copy
}
