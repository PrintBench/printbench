import { serveFile } from '@/lib/serve-file'

export const dynamic = 'force-dynamic'

/** The plain form, used by the viewer and the download links in the UI. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ fileId: string }> },
): Promise<Response> {
  const { fileId } = await params
  return serveFile(request, fileId)
}
