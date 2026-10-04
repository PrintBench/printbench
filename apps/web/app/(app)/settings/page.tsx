import { PageHeader } from '@/components/shell/page-header'
import { NotPermitted } from '@/components/shell/not-permitted'
import { readMakerWorldCookieStatus } from './makerworld-actions'
import { MakerWorldConnectionForm } from './makerworld-connection-form'
import { readThingiverseTokenStatus } from './thingiverse-actions'
import { ThingiverseConnectionForm } from './thingiverse-connection-form'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Account settings' }

export default async function AccountSettingsPage() {
  const [result, thingiverse] = await Promise.all([
    readMakerWorldCookieStatus(),
    readThingiverseTokenStatus(),
  ])
  if (
    (!result.ok && result.error === 'Not permitted.') ||
    (!thingiverse.ok && thingiverse.error === 'Not permitted.')
  ) {
    return <NotPermitted what="model source account settings" />
  }

  return (
    <>
      <PageHeader
        title="Account settings"
        description="Manage connections for your own PrintBench account."
      />
      <div className="max-w-3xl space-y-6">
        {result.ok ? (
          <MakerWorldConnectionForm initialSaved={result.saved} />
        ) : (
          <p role="alert" className="text-sm text-[var(--color-danger)]">
            {result.error}
          </p>
        )}
        {thingiverse.ok ? (
          <ThingiverseConnectionForm initialSaved={thingiverse.saved} />
        ) : (
          <p role="alert" className="text-sm text-[var(--color-danger)]">
            {thingiverse.error}
          </p>
        )}
      </div>
    </>
  )
}
