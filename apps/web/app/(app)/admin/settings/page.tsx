import { can, getSettings } from '@pb/core'
import { getSessionUser } from '@pb/auth'
import { getDb } from '@pb/db'
import { PageHeader } from '@/components/shell/page-header'
import { NotPermitted } from '@/components/shell/not-permitted'
import { SettingsForm } from './settings-form'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Settings' }

export default async function SettingsPage() {
  const user = await getSessionUser()
  if (!can({ id: user?.id ?? '', role: user?.role ?? null }, 'settings:manage')) {
    return <NotPermitted what="settings" />
  }

  const settings = await getSettings(getDb())

  return (
    <>
      <PageHeader
        title="Settings"
        description="Instance-wide options. Anything that belongs to one library is on that library instead."
      />
      <SettingsForm initial={settings} />
    </>
  )
}
