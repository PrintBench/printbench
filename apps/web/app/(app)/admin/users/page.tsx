import { desc } from 'drizzle-orm'
import { UserPlus } from 'lucide-react'
import { getSessionUser } from '@pm/auth'
import { can } from '@pm/core'
import { getDb, schema } from '@pm/db'
import { PageHeader } from '@/components/shell/page-header'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { NotPermitted } from '@/components/shell/not-permitted'
import { RoleSelect } from './role-select'

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

  const users = await getDb()
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

  return (
    <>
      <PageHeader
        title="Users"
        description="Who can reach this instance, and what they may do."
        actions={
          <Button disabled title="Invitations arrive in a later phase">
            <UserPlus />
            Invite
          </Button>
        }
      />

      <Card className="overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--color-border)] text-left text-xs uppercase tracking-wider text-[var(--color-ink-faint)]">
              <th className="px-4 py-2.5 font-medium">User</th>
              <th className="hidden px-4 py-2.5 font-medium sm:table-cell">Joined</th>
              <th className="px-4 py-2.5 font-medium">Role</th>
            </tr>
          </thead>
          <tbody>
            {users.map((row) => (
              <tr
                key={row.id}
                className="border-b border-[var(--color-border)] last:border-0"
              >
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{row.name}</span>
                    {row.id === admin!.id && <Badge tone="accent">You</Badge>}
                    {row.banned && <Badge tone="danger">Suspended</Badge>}
                  </div>
                  <span className="text-xs text-[var(--color-ink-faint)]">{row.email}</span>
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
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <p className="mt-4 text-xs text-[var(--color-ink-faint)]">
        Viewers browse and download. Members also add and edit models, tags and print history.
        Admins additionally manage libraries, users and settings.
      </p>
    </>
  )
}
