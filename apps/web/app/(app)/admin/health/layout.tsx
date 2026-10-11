import { can } from '@pb/core'
import { getSessionUser } from '@pb/auth'
import { DiagnosticsTabs, type DiagnosticsTab } from './diagnostics-tabs'

/**
 * Diagnostics: library health, plus the three views for whoever runs the
 * instance — what people did, what the app logged, and a report to attach to
 * a bug.
 *
 * Each tab is offered only to someone who may open it; the pages check again
 * themselves, because a hidden tab is not authorization.
 */
export default async function DiagnosticsLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser()
  const subject = { id: user?.id ?? '', role: user?.role ?? null, banned: user?.banned ?? false }

  const tabs: DiagnosticsTab[] = []
  if (can(subject, 'library:manage')) tabs.push({ href: '/admin/health', label: 'Library health' })
  if (can(subject, 'diagnostics:view')) {
    tabs.push(
      { href: '/admin/health/audit', label: 'Audit trail' },
      { href: '/admin/health/logs', label: 'Logs' },
      { href: '/admin/health/debug', label: 'Debug info' },
    )
  }

  return (
    <>
      {tabs.length > 1 && <DiagnosticsTabs tabs={tabs} />}
      {children}
    </>
  )
}
