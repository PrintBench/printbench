import { createReadStream } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { analyzeMesh, renderRemoteThumbnail, MAX_REMOTE_ARTWORK_BYTES } from '@pb/mesh'
import { getDb } from '@pb/db'
import {
  processMakerWorldImport,
  fetchMakerWorldModel,
  fetchPrintablesModel,
  fetchThingiverseModel,
  parseModelSourceUrl,
  downloadMakerWorldFile,
  downloadSourceFile,
} from '@pb/core'
import { JOB, getQueue, type JobPayload } from '@pb/jobs'

/** Temporary bytes never enter a library until a complete download is validated. */
export async function handleMakerWorldImport(
  payload: JobPayload<typeof JOB.makerWorldImport>,
): Promise<void> {
  const temporary = await mkdtemp(path.join(tmpdir(), 'pb-model-source-'))
  let sequence = 0
  try {
    await processMakerWorldImport(getDb(), payload.importId, {
      fetchModel: (url, credential) => {
        const { provider } = parseModelSourceUrl(url)
        if (provider === 'printables') return fetchPrintablesModel(url)
        if (provider === 'thingiverse') return fetchThingiverseModel(url, credential)
        return fetchMakerWorldModel(url, credential)
      },
      download: async (url, kind, context) => {
        if (!context) throw new Error('Model source download context is missing')
        const filename = path.join(temporary, `download-${sequence++}`)
        const maxBytes = kind === 'image' ? MAX_REMOTE_ARTWORK_BYTES : 512 * 1024 * 1024
        const bytes =
          context.provider === 'makerworld'
            ? await downloadMakerWorldFile(url, filename, { maxBytes })
            : await downloadSourceFile(context.provider, url, filename, {
                maxBytes,
                token: context.token,
              })
        if (kind === 'image') {
          const image = await renderRemoteThumbnail(await readFile(filename), {
            size: 2048,
            quality: 90,
          })
          if (!image) throw new Error('Unsupported artwork')
          return Readable.from(image.data)
        }
        // Streaming parsers reject HTML, corrupt archives, empty geometry and
        // implausible dimensions before downloaded bytes enter a library.
        const stats = await analyzeMesh(kind, () => createReadStream(filename), {
          byteLength: bytes,
        })
        if (!stats.bbox || !stats.triangleCount || stats.truncated)
          throw new Error('Source file does not contain complete 3D geometry')
        return createReadStream(filename)
      },
      onDerivedWork: async (fileIds) => {
        const queue = getQueue()
        const jobs = fileIds.map((fileId) => ({ fileId }))
        await queue.sendMany(JOB.fileAnalyze, jobs)
        await queue.sendMany(JOB.fileThumbnail, jobs)
        await queue.sendMany(JOB.fileDigest, jobs)
      },
    })
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}
