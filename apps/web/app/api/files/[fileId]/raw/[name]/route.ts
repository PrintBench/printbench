import { serveFile } from '@/lib/serve-file'

export const dynamic = 'force-dynamic'

/**
 * The same bytes, at a URL that ends in the real filename.
 *
 * Desktop slicers work out what they have been handed from the URL, not from
 * Content-Type or Content-Disposition. Given `/api/files/<uuid>/raw` Bambu
 * Studio downloads the file, sees a path ending in "raw", and reports an
 * unknown or corrupt format — for a file that is perfectly valid.
 *
 * The trailing segment is decorative: authorisation and lookup still key off
 * the file id, so a wrong or stale name changes nothing about what is served.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ fileId: string; name: string }> },
): Promise<Response> {
  const { fileId } = await params
  return serveFile(request, fileId)
}
