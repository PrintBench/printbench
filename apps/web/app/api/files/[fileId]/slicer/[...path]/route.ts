import { serveAs3mf } from '@/lib/serve-as-3mf'

export const dynamic = 'force-dynamic'

/**
 * The mesh as a 3MF, for handing to a desktop slicer.
 *
 * A catch-all because the URL has to satisfy two Bambu Studio behaviours at
 * once, and Next will not let two differently-named slugs share a level.
 *
 *   /slicer/<expires>-<token>/Model.3mf   preferred
 *   /slicer/Model.3mf                     credentials in the query string
 *
 * The extension matters because Bambu checks it BEFORE downloading and refuses
 * anything but .3mf. The absence of a query string matters because it names
 * the downloaded file after the last path segment, and `?` and `&` are illegal
 * in Windows filenames — with them the transfer reports "Project downloaded
 * 100%" and then nothing loads, because the file could never be written.
 *
 * Both segments are decorative as far as access goes: authorisation and lookup
 * key off the file id.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ fileId: string; path: string[] }> },
): Promise<Response> {
  const { fileId, path } = await params
  // Two segments means the first carries the signature; one means it does not.
  const credential = path.length > 1 ? path[0] : undefined
  return serveAs3mf(request, fileId, credential)
}
