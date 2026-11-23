import { z } from 'zod'
import { clipperJson, withClipperUser } from '@/lib/clipper-api'
import { ModelImportQueueError, submitModelSourceImport } from '@/lib/model-source-import'

const inputSchema = z.object({ libraryId: z.uuid(), url: z.string().min(1).max(4096) })
const bodyLimit = 8192

async function readInput(request: Request) {
  const reader = request.body?.getReader()
  if (!reader) return null
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let size = 0
  let body = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > bodyLimit) {
        await reader.cancel()
        return null
      }
      body += decoder.decode(value, { stream: true })
    }
    const result = inputSchema.safeParse(JSON.parse(body + decoder.decode()))
    return result.success ? result.data : null
  } catch {
    return null
  } finally {
    reader.releaseLock()
  }
}

export function POST(request: Request): Promise<Response> {
  return withClipperUser(request, async (_db, user) => {
    const input = await readInput(request)
    if (!input) return clipperJson({ error: 'Provide a library ID and a model URL.' }, 400)
    try {
      return clipperJson(await submitModelSourceImport(user, input), 202)
    } catch (error) {
      if (error instanceof ModelImportQueueError) return clipperJson({ error: error.message }, 503)
      throw error
    }
  })
}
