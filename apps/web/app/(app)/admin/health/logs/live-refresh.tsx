'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Pause, Play } from 'lucide-react'
import { Button } from '@/components/ui/button'

const INTERVAL_MS = 5_000

/**
 * Follows the log, like `docker logs -f`.
 *
 * Off by default: a page that reloads itself is a surprise when you are
 * halfway through reading a stack trace. Pauses while the tab is hidden.
 */
export function LiveRefresh() {
  const router = useRouter()
  const [live, setLive] = useState(false)

  useEffect(() => {
    if (!live) return
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') router.refresh()
    }, INTERVAL_MS)
    return () => clearInterval(timer)
  }, [live, router])

  return (
    <Button
      variant={live ? 'primary' : 'secondary'}
      size="sm"
      aria-pressed={live}
      onClick={() => {
        if (!live) router.refresh()
        setLive(!live)
      }}
    >
      {live ? <Pause /> : <Play />}
      {live ? 'Following' : 'Follow'}
    </Button>
  )
}
