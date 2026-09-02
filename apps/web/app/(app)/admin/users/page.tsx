import { headers } from 'next/headers'
import { desc } from 'drizzle-orm'
import { getSessionUser } from '@pb/auth'
import { can, listPendingInvites } from '@pb/core'
import { getDb, schema } from '@pb/db'
import { PageHeader } from '@/components/shell/page-header'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { NotPermitted } from '@/components/shell/not-permitted'
import { RoleSelect } from './role-select'
import { UserActions } from './user-actions'
import { AddPeople } from './add-people'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Users' }

const DATE = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' })

export default async function UsersPage() {
  /*
   * Enforced server-side; the sidebar hiding this link is only cosmetic.
   * Rendered as a refusal rather than thrown, so an unauthorized visit is a
   * legible screen instead of a 500. The action behind the role selector
   * re-checks independently.
   */
  const admin = await getSessionUser()
  if (!can({ id: admin?.id ?? '', role: admin?.role ?? null }, 'user:manage')) {
    return <NotPermitted what="user management" />
  }

  const db = getDb()

  const users = await db
    .select({
      id: schema.user.id,
      name: schema.user.name,
      email: schema.user.email,
      role: schema.user.role,
      banned: schema.user.banned,
      createdAt: schema.user.createdAt,
    })
    .from(schema.user)
    .orderBy(desc(schema.user.createdAt))

  const pending = await listPendingInvites(db)

  /*
   * The origin an invitation link should carry, taken from the request rather
   * than from configuration: whoever is reading this page reached it somehow,
   * and that host is the one their colleague will also be able to reach. A
   * configured APP_URL is frequently the container's idea of itself.
   */
  const requestHeaders = await headers()
  const forwardedHost = requestHeaders.get('x-forwarded-host') ?? requestHeaders.get('host')
  const protocol = requestHeaders.get('x-forwarded-proto') ?? 'http'
  const origin = forwardedHost
    ? `${protocol}://${forwardedHost}`
    : (process.env.APP_URL ?? 'http://localhost:3000')

  return (
    <>
      <PageHeader title="Users" description="Who can reach this instance, and what they may do." />

      <div className="mb-6">
        <AddPeople
          origin={origin}
          pending={pending.map((entry) => ({
            id: entry.id,
            token: entry.token,
            email: entry.email,
            role: entry.role,
            expiresAt: entry.expiresAt.toISOString(),
            invitedByName: entry.invitedByName,
          }))}
        />
      </div>

      <Card className="overflow-hidden">
        {/*
          The card clips, so without a scroller of its own a table too wide for
          the screen loses its right-hand columns entirely — on a phone that
          hid the role control and the row actions with no way to reach them.
        */}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--color-border)] text-left text-xs uppercase tracking-wider text-[var(--color-ink-faint)]">
                <th className="px-4 py-2.5 font-medium">User</th>
                <th className="hidden px-4 py-2.5 font-medium sm:table-cell">Joined</th>
                <th className="px-4 py-2.5 font-medium">Role</th>
                <th className="px-4 py-2.5 text-right font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {users.map((row) => (
                <tr key={row.id} className="border-b border-[var(--color-border)] last:border-0">
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{row.name}</span>
                      {row.id === admin!.id && <Badge tone="accent">You</Badge>}
                      {row.banned && <Badge tone="danger">Suspended</Badge>}
                    </div>
                    {/* break-all: an address has no break opportunity, and a long
                      one would otherwise set the width of the whole table. */}
                    <span className="break-all text-xs text-[var(--color-ink-faint)]">
                      {row.email}
                    </span>
                  </td>
                  <td className="hidden px-4 py-3 text-[var(--color-ink-muted)] sm:table-cell">
                    {DATE.format(row.createdAt)}
                  </td>
                  <td className="px-4 py-3">
                    <RoleSelect
                      userId={row.id}
                      role={row.role}
                      // Removing your own admin rights can lock everyone out of
                      // the instance, so the control is disabled for yourself.
                      disabled={row.id === admin!.id}
                    />
                  </td>
                  <td className="px-4 py-3 text-right">
                    {/*
                    Nothing offered for your own account: suspending or
                    deleting yourself is a lockout with no way back through
                    the UI, and the server refuses both regardless.
                  */}
                    {row.id !== admin!.id && (
                      <UserActions
                        userId={row.id}
                        name={row.name}
                        email={row.email}
                        suspended={row.banned}
                      />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <p className="mt-4 text-xs text-[var(--color-ink-faint)]">
        Viewers browse and download. Members also add and edit models, tags and print history.
        Admins additionally manage libraries, users and settings.
      </p>
    </>
  )
}
