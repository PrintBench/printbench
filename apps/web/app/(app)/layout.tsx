import { redirect } from 'next/navigation'
import { getSessionUser } from '@pb/auth'
import { can, getSettings, queueStats } from '@pb/core'
import { getDb } from '@pb/db'
import { needsFirstRunSetup } from '@/lib/setup'
import { Sidebar } from '@/components/shell/sidebar'
import { PreviewStatusProvider } from '@/components/model/preview-status-provider'
import { ActivityPanel } from '@/components/shell/activity-panel'

export const dynamic = 'force-dynamic'

/**
 * Every page under this layout requires a session. The check lives here rather
 * than in middleware so it runs in the Node runtime with database access; each
 * mutating action re-checks permission anyway.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  if (await needsFirstRunSetup()) redirect('/setup')

  const user = await getSessionUser()
  if (!user) redirect('/login')

  const db = getDb()
  const policyUser = { id: user.id, role: user.role ?? 'viewer', banned: user.banned ?? false }

  /*
   * The queue count is read here rather than inside the nav so the pill is
   * right on first paint and costs one query per page view, not one per nav
   * item. It is skipped for a user who cannot see the queue link at all, and
   * runs alongside the settings read rather than after it.
   */
  const [{ siteName }, queue] = await Promise.all([
    getSettings(db),
    can(policyUser, 'request:create') ? queueStats(db) : null,
  ])

  // Incomplete is requested plus printing: what is still to come off a
  // printer. Done and cancelled are finished with.
  const counts = queue ? { '/queue': queue.waiting + queue.printing } : {}

  return (
    <div className="flex min-h-dvh flex-col lg:flex-row">
      <Sidebar
        siteName={siteName}
        counts={counts}
        user={{ ...policyUser, name: user.name, email: user.email }}
      />
      <main className="min-w-0 flex-1">
        <div className="mx-auto max-w-6xl px-5 py-8 sm:px-8">
          <PreviewStatusProvider>{children}</PreviewStatusProvider>
        </div>
      </main>
      <ActivityPanel />
    </div>
  )
}
