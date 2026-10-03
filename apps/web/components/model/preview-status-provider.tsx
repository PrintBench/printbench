'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ModelPreviewStatus } from '@pb/core'
import { createPreviewPoller } from './preview-poller'

const PreviewContext = createContext<{
  statuses: Record<string, ModelPreviewStatus>
  register: (id: string) => () => void
} | null>(null)

export function PreviewStatusProvider({ children }: { children: React.ReactNode }) {
  const [registrations, setRegistrations] = useState<Record<string, number>>({})
  const [statuses, setStatuses] = useState<Record<string, ModelPreviewStatus>>({})
  const register = useCallback((id: string) => {
    setRegistrations((current) => ({ ...current, [id]: (current[id] ?? 0) + 1 }))
    return () =>
      setRegistrations((current) => {
        const next = { ...current }
        const count = next[id] ?? 0
        if (count > 1) next[id] = count - 1
        else delete next[id]
        return next
      })
  }, [])
  const idsKey = Object.keys(registrations).sort().join(',')

  useEffect(() => {
    if (!idsKey) return
    const poller = createPreviewPoller({
      ids: idsKey.split(','),
      isVisible: () => document.visibilityState !== 'hidden',
      fetchStatuses: async (ids, signal) => {
        const query = new URLSearchParams(ids.map((id) => ['id', id]))
        const response = await fetch(`/api/models/previews?${query}`, { signal, cache: 'no-store' })
        if (response.status === 401 || response.status === 403) return null
        if (!response.ok) throw new Error('Could not read preview status')
        return ((await response.json()) as { previews: ModelPreviewStatus[] }).previews
      },
      onStatuses: (updates) =>
        setStatuses((current) => ({
          ...current,
          ...Object.fromEntries(updates.map((status) => [status.publicId, status])),
        })),
    })
    const refresh = () => void poller.refresh()
    refresh()
    document.addEventListener('visibilitychange', refresh)
    return () => {
      poller.stop()
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [idsKey])

  const value = useMemo(() => ({ statuses, register }), [statuses, register])
  return <PreviewContext.Provider value={value}>{children}</PreviewContext.Provider>
}

export function usePreviewStatus(publicId: string, enabled: boolean) {
  const context = useContext(PreviewContext)
  const register = context?.register
  useEffect(() => {
    if (enabled && register) return register(publicId)
  }, [enabled, publicId, register])
  return enabled ? context?.statuses[publicId] : undefined
}
