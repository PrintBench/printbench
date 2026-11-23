import { can, checkForUpdate, getSettings } from '@pb/core'
import { getSessionUser } from '@pb/auth'
import { getDb } from '@pb/db'
import { PageHeader } from '@/components/shell/page-header'
import { NotPermitted } from '@/components/shell/not-permitted'
import { SettingsForm } from './settings-form'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'System settings' }

export default async function SettingsPage() {
  const user = await getSessionUser()
  if (!can({ id: user?.id ?? '', role: user?.role ?? null }, 'settings:manage')) {
    return <NotPermitted what="settings" />
  }

  const settings = await getSettings(getDb())
  /*
   * Cached for hours, so this is normally free; the first load after a restart
   * waits on one bounded request. Nothing is read when the check is off.
   */
  const update = settings.updateChecks
    ? await checkForUpdate({ currentVersion: process.env.PB_VERSION })
    : null

  return (
    <>
      <PageHeader
        title="System settings"
        description="Instance-wide options. Anything that belongs to one library is on that library instead."
      />
      <SettingsForm initial={settings} update={update} />
    </>
  )
}
