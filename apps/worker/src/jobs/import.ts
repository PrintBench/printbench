import { createReadStream } from 'node:fs'
import { mkdtemp, open, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { renderRemoteThumbnail } from '@pb/mesh'
import { getDb } from '@pb/db'
import { processMakerWorldImport, fetchMakerWorldModel, downloadMakerWorldFile } from '@pb/core'
import { JOB, getQueue, type JobPayload } from '@pb/jobs'

/** Temporary bytes never enter a library until a complete download is validated. */
export async function handleMakerWorldImport(
  payload: JobPayload<typeof JOB.makerWorldImport>,
): Promise<void> {
  const temporary = await mkdtemp(path.join(tmpdir(), 'pb-makerworld-'))
  let sequence = 0
  try {
    await processMakerWorldImport(getDb(), payload.importId, {
      fetchModel: fetchMakerWorldModel,
      download: async (url, kind) => {
        const filename = path.join(temporary, `download-${sequence++}`)
        await downloadMakerWorldFile(url, filename, {
          maxBytes: kind === 'image' ? 4 * 1024 * 1024 : 512 * 1024 * 1024,
        })
        if (kind === 'image') {
          const input = await readFile(filename)
          const image = await renderRemoteThumbnail(input)
          if (!image) throw new Error('Unsupported artwork')
          return Readable.from(image.data)
        }
        const file = await open(filename, 'r')
        try {
          const header = Buffer.alloc(4)
          await file.read(header, 0, 4, 0)
          if (!header.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])))
            throw new Error('Not a 3MF archive')
        } finally {
          await file.close()
        }
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
