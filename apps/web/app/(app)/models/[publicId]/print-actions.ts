'use server'

import { eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { headers } from 'next/headers'
import {
  PolicyError,
  PrintValidationError,
  assertCan,
  deletePrint,
  logPrint,
  printBelongsToModel,
  signToken,
  slicerUrl,
  slicersFor,
  updatePrint,
  type PrintEntry,
  type PrintStatus,
} from '@pm/core'
import { requireUser } from '@pm/auth'
import { getDb, schema } from '@pm/db'

type Result = { ok: true } | { ok: false; error: string }

/** What the log-a-print form sends. Dates arrive as strings from the browser. */
export interface PrintFormInput {
  modelFileId?: string | null
  printerName?: string | null
  material?: string | null
  colorHex?: string | null
  layerHeightMm?: number | null
  nozzleMm?: number | null
  status?: PrintStatus
  startedAt?: string | null
  finishedAt?: string | null
  durationMin?: number | null
  filamentUsedG?: number | null
  rating?: number | null
  notes?: string | null
}

function toEntry(input: PrintFormInput): Omit<PrintEntry, 'modelId'> {
  return {
    modelFileId: input.modelFileId || null,
    printerName: input.printerName ?? null,
    material: input.material ?? null,
    colorHex: input.colorHex ?? null,
    layerHeightMm: input.layerHeightMm ?? null,
    nozzleMm: input.nozzleMm ?? null,
    status: input.status ?? 'success',
    startedAt: input.startedAt ? new Date(input.startedAt) : null,
    finishedAt: input.finishedAt ? new Date(input.finishedAt) : null,
    durationMin: input.durationMin ?? null,
    filamentUsedG: input.filamentUsedG ?? null,
    rating: input.rating ?? null,
    notes: input.notes ?? null,
  }
}

async function modelIdFor(publicId: string): Promise<string | null> {
  const rows = await getDb()
    .select({ id: schema.models.id })
    .from(schema.models)
    .where(eq(schema.models.publicId, publicId))
    .limit(1)
  return rows[0]?.id ?? null
}

export async function recordPrint(publicId: string, input: PrintFormInput): Promise<Result> {
  try {
    const user = await requireUser()
    assertCan({ id: user.id, role: user.role ?? null, banned: user.banned ?? false }, 'print:log')

    const modelId = await modelIdFor(publicId)
    if (!modelId) return { ok: false, error: 'That model no longer exists.' }

    await logPrint(getDb(), { ...toEntry(input), modelId, userId: user.id })

    revalidatePath(`/models/${publicId}`)
    revalidatePath('/prints')
    revalidatePath('/')
    return { ok: true }
  } catch (error) {
    return { ok: false, error: describe(error, 'Could not log the print.') }
  }
}

export async function editPrint(
  publicId: string,
  printId: string,
  input: PrintFormInput,
): Promise<Result> {
  try {
    const user = await requireUser()
    assertCan({ id: user.id, role: user.role ?? null, banned: user.banned ?? false }, 'print:log')

    const modelId = await modelIdFor(publicId)
    if (!modelId) return { ok: false, error: 'That model no longer exists.' }

    /*
     * The print id comes from the client, so it is checked against the model in
     * the URL. Without this, one model's page could edit another's history.
     */
    if (!(await printBelongsToModel(getDb(), printId, modelId))) {
      return { ok: false, error: 'That print does not belong to this model.' }
    }

    await updatePrint(getDb(), printId, toEntry(input))

    revalidatePath(`/models/${publicId}`)
    revalidatePath('/prints')
    return { ok: true }
  } catch (error) {
    return { ok: false, error: describe(error, 'Could not save the change.') }
  }
}

export async function removePrint(publicId: string, printId: string): Promise<Result> {
  try {
    const user = await requireUser()
    assertCan({ id: user.id, role: user.role ?? null, banned: user.banned ?? false }, 'print:log')

    const modelId = await modelIdFor(publicId)
    if (!modelId) return { ok: false, error: 'That model no longer exists.' }
    if (!(await printBelongsToModel(getDb(), printId, modelId))) {
      return { ok: false, error: 'That print does not belong to this model.' }
    }

    await deletePrint(getDb(), printId)

    revalidatePath(`/models/${publicId}`)
    revalidatePath('/prints')
    revalidatePath('/')
    return { ok: true }
  } catch (error) {
    return { ok: false, error: describe(error, 'Could not delete the print.') }
  }
}

/** Long enough for the slicer to launch and fetch, short enough that a leak dies. */
const SLICER_TOKEN_TTL_MS = 15 * 60 * 1000

type SlicerLinks =
  | {
      ok: true
      links: { id: string; label: string; url: string; hint: string }[]
      /** True when the mesh is repackaged as 3MF on the way out. */
      converted?: boolean
      /** True when that repackaging drops something — colour, materials. */
      lossy?: boolean
    }
  | { ok: false; error: string }

/**
 * Mints the `slicer://open?file=…` links for one file.
 *
 * Built on demand rather than rendered into the page because the signature
 * expires: a link baked into HTML would be dead by the time someone came back
 * to the tab, and the failure would be silent — the slicer would simply open
 * empty.
 */
export async function createSlicerLinks(fileId: string): Promise<SlicerLinks> {
  try {
    const user = await requireUser()
    assertCan(
      { id: user.id, role: user.role ?? null, banned: user.banned ?? false },
      'file:download',
    )

    const secret = process.env.BETTER_AUTH_SECRET
    if (!secret) return { ok: false, error: 'Signed links are not configured on this server.' }

    const rows = await getDb()
      .select({ extension: schema.modelFiles.extension, filename: schema.modelFiles.filename })
      .from(schema.modelFiles)
      .where(eq(schema.modelFiles.id, fileId))
      .limit(1)

    const file = rows[0]
    if (!file) return { ok: false, error: 'That file no longer exists.' }

    const slicers = slicersFor(file.extension)
    if (slicers.length === 0) return { ok: true, links: [] }

    /*
     * The slicer fetches this itself, from the desktop, so the URL must be
     * absolute and reachable from there — a relative path means nothing outside
     * the browser. APP_URL is the configured public address; the request Host is
     * the fallback, which is what makes this work on a LAN address nobody set.
     */
    const origin = process.env.APP_URL ?? (await originFromRequest())
    if (!origin) return { ok: false, error: 'Set APP_URL so slicer links can be built.' }

    const { token, expires } = signToken(secret, 'file', fileId, SLICER_TOKEN_TTL_MS)

    /*
     * Handed over as 3MF, at a URL ending in ".3mf".
     *
     * Bambu Studio's URL handler checks the extension BEFORE downloading:
     *
     *   if (!extension.Contains(".3mf") && !extension.Contains(".3MF")) {
     *     msg = _L("Download failed, unknown file format."); return; }
     *
     * so a link to an STL is refused without a single request reaching us,
     * however correct the file and its headers are. Converting on the way out
     * is the only thing that makes this work, and every other slicer reads 3MF
     * too — so one URL serves them all.
     *
     * Only the last path segment, because a file inside a model folder has a
     * filename like "stl/body.stl" and the slashes would change the path.
     */
    const leaf = (file.filename.split('/').pop() ?? 'model').replace(/\.[^.]+$/, '')
    const name = encodeURIComponent(`${leaf || 'model'}.3mf`)

    const fileUrl =
      `${origin.replace(/\/+$/, '')}/api/files/${fileId}/slicer/${name}` +
      `?token=${token}&expires=${expires}`

    return {
      ok: true,
      converted: file.extension.toLowerCase() !== '3mf',
      // Colour and materials do not survive the conversion; geometry does.
      lossy: ['obj', 'ply'].includes(file.extension.toLowerCase()),
      links: slicers.map((slicer) => ({
        id: slicer.id,
        label: slicer.label,
        url: slicerUrl(slicer, fileUrl),
        hint: slicer.hint,
      })),
    }
  } catch (error) {
    return { ok: false, error: describe(error, 'Could not prepare the slicer link.') }
  }
}

async function originFromRequest(): Promise<string | null> {
  const headerList = await headers()
  const host = headerList.get('x-forwarded-host') ?? headerList.get('host')
  if (!host) return null
  const proto = headerList.get('x-forwarded-proto') ?? 'http'
  // localhost only reaches a slicer on the same machine; the caller says so.
  return `${proto}://${host}`
}

function describe(error: unknown, fallback: string): string {
  if (error instanceof PrintValidationError) return error.message
  if (error instanceof PolicyError) return 'Not permitted.'
  return fallback
}
