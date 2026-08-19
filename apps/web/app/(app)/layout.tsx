import { redirect } from 'next/navigation'
import { getSessionUser } from '@pm/auth'
import { needsFirstRunSetup } from '@/lib/setup'
import { Sidebar } from '@/components/shell/sidebar'

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

  return (
    <div className="flex min-h-dvh flex-col lg:flex-row">
      <Sidebar
        user={{
          id: user.id,
          role: user.role ?? 'viewer',
          banned: user.banned ?? false,
          name: user.name,
          email: user.email,
        }}
      />
      <main className="min-w-0 flex-1">
        <div className="mx-auto max-w-6xl px-5 py-8 sm:px-8">{children}</div>
      </main>
    </div>
  )
}
