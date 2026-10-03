import type { ModelPreviewStatus } from '@pb/core'

const BATCH_SIZE = 200
const INTERVAL_MS = 3000

/** One batch request for the page, then only its unfinished previews. */
export function createPreviewPoller({
  ids,
  fetchStatuses,
  onStatuses,
  isVisible,
}: {
  ids: string[]
  fetchStatuses: (ids: string[], signal: AbortSignal) => Promise<ModelPreviewStatus[] | null>
  onStatuses: (statuses: ModelPreviewStatus[]) => void
  isVisible: () => boolean
}) {
  let pending = [...new Set(ids)]
  let stopped = false
  let running = false
  let delay = INTERVAL_MS
  let timer: ReturnType<typeof setTimeout> | undefined
  const controller = new AbortController()

  async function refresh() {
    if (stopped || running || pending.length === 0) return
    clearTimeout(timer)
    if (!isVisible()) return
    running = true
    try {
      const next: string[] = []
      for (let offset = 0; offset < pending.length; offset += BATCH_SIZE) {
        const batch = pending.slice(offset, offset + BATCH_SIZE)
        const statuses = await fetchStatuses(batch, controller.signal)
        if (stopped) return
        // A revoked session/permission ends polling rather than retrying forever.
        if (statuses === null) {
          stopped = true
          return
        }
        const byId = new Map(statuses.map((status) => [status.publicId, status]))
        onStatuses(
          batch.map(
            (publicId) =>
              byId.get(publicId) ?? {
                publicId,
                state: 'unavailable',
                previewImageFileId: null,
                thumbFileId: null,
                thumbKey: null,
              },
          ),
        )
        next.push(
          ...statuses
            .filter((status) => status.state === 'pending')
            .map((status) => status.publicId),
        )
      }
      pending = next
      delay = INTERVAL_MS
    } catch {
      // Temporary network failures keep the placeholder and retry with bounded backoff.
      delay = Math.min(delay * 2, 30_000)
    } finally {
      running = false
      if (!stopped && pending.length > 0 && isVisible())
        timer = setTimeout(() => void refresh(), delay)
    }
  }

  return {
    refresh,
    stop() {
      stopped = true
      clearTimeout(timer)
      controller.abort()
    },
  }
}
