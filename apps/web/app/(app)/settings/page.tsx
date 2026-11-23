import { requireUser } from '@pb/auth'
import { can } from '@pb/core/policy'
import { PageHeader } from '@/components/shell/page-header'
import { getDb } from '@pb/db'
import { listClipperTokens } from '@/lib/clipper-tokens'
import { ClipperSettings } from './clipper-settings'
import { PasswordForm } from './password-form'
import { readMakerWorldCookieStatus } from './makerworld-actions'
import { MakerWorldConnectionForm } from './makerworld-connection-form'
import { readThingiverseTokenStatus } from './thingiverse-actions'
import { ThingiverseConnectionForm } from './thingiverse-connection-form'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Account settings' }

export default async function AccountSettingsPage() {
  const user = await requireUser()
  const canImport = can(
    { id: user.id, role: user.role ?? null, banned: user.banned ?? false },
    'file:upload',
  )
  const [clipperTokens, connections] = await Promise.all([
    listClipperTokens(getDb(), user.id),
    canImport ? Promise.all([readMakerWorldCookieStatus(), readThingiverseTokenStatus()]) : null,
  ])

  return (
    <>
      <PageHeader
        title="Account settings"
        description="Manage your PrintBench account password and model source connections."
      />
      <div className="max-w-3xl space-y-6">
        <PasswordForm email={user.email} />
        {(canImport || clipperTokens.length > 0) && (
          <ClipperSettings initialTokens={clipperTokens} canImport={canImport} />
        )}
        {connections && (
          <>
            {connections[0].ok ? (
              <MakerWorldConnectionForm initialSaved={connections[0].saved} />
            ) : (
              <p role="alert" className="text-sm text-[var(--color-danger)]">
                {connections[0].error}
              </p>
            )}
            {connections[1].ok ? (
              <ThingiverseConnectionForm initialSaved={connections[1].saved} />
            ) : (
              <p role="alert" className="text-sm text-[var(--color-danger)]">
                {connections[1].error}
              </p>
            )}
          </>
        )}
      </div>
    </>
  )
}
