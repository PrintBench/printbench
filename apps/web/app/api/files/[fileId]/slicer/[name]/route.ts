import { serveAs3mf } from '@/lib/serve-as-3mf'

export const dynamic = 'force-dynamic'

/**
 * The mesh, as a 3MF, at a URL ending in ".3mf".
 *
 * Both halves matter. Bambu Studio checks the extension in the URL before it
 * downloads anything, and it refuses everything that is not 3MF — so the path
 * has to end in .3mf, and what arrives has to actually be one.
 *
 * The trailing segment is decorative: authorisation and lookup key off the
 * file id, so a wrong name changes nothing about what is served.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ fileId: string; name: string }> },
): Promise<Response> {
  const { fileId } = await params
  return serveAs3mf(request, fileId)
}
