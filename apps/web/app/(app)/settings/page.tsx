import { PageHeader } from '@/components/shell/page-header'
import { NotPermitted } from '@/components/shell/not-permitted'
import { readMakerWorldCookieStatus } from './makerworld-actions'
import { MakerWorldConnectionForm } from './makerworld-connection-form'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Account settings' }

export default async function AccountSettingsPage() {
  const result = await readMakerWorldCookieStatus()
  if (!result.ok && result.error === 'Not permitted.') {
    return <NotPermitted what="MakerWorld account settings" />
  }

  return (
    <>
      <PageHeader
        title="Account settings"
        description="Manage connections for your own PrintBench account."
      />
      <div className="max-w-3xl">
        {result.ok ? (
          <MakerWorldConnectionForm initialSaved={result.saved} />
        ) : (
          <p role="alert" className="text-sm text-[var(--color-danger)]">
            {result.error}
          </p>
        )}
      </div>
    </>
  )
}
