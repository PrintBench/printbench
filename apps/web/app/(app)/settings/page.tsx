import { requireUser } from '@pb/auth'
import { PageHeader } from '@/components/shell/page-header'
import { PasswordForm } from './password-form'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Account settings' }

export default async function AccountSettingsPage() {
  const user = await requireUser()
  return (
    <>
      <PageHeader title="Account settings" description="Manage your PrintBench account password." />
      <div className="max-w-3xl space-y-6">
        <PasswordForm email={user.email} />
      </div>
    </>
  )
}
