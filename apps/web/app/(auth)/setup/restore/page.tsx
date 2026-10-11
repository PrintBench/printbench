import Link from 'next/link'
import { redirect } from 'next/navigation'
import { ArchiveRestore } from 'lucide-react'
import { needsFirstRunSetup } from '@/lib/setup'
import { RestorePanel } from '@/components/backup/restore-panel'
import { createFirstRunRestoreTicket } from './actions'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Restore from a backup' }

export default async function SetupRestorePage() {
  // Closes with the rest of setup: on an instance that already has accounts,
  // restoring is an admin's job, from Manage → Backup.
  if (!(await needsFirstRunSetup())) redirect('/login')

  return (
    <>
      <div className="mb-6">
        <span className="mb-4 inline-flex items-center gap-1.5 rounded-full bg-[var(--color-accent-soft)] px-2.5 py-1 text-xs font-medium text-[var(--color-accent)]">
          <ArchiveRestore className="size-3.5" />
          First run
        </span>
        <h1 className="text-2xl font-semibold tracking-tight">Restore from a backup</h1>
        <p className="mt-1 text-sm text-[var(--color-ink-muted)]">
          Bring across everything from another PrintBench: accounts, libraries, tags, print history
          and settings. You then sign in with an account from that instance.
        </p>
      </div>

      <RestorePanel
        getTicket={createFirstRunRestoreTicket}
        firstRun
        footer={
          <p className="pt-3 text-sm text-[var(--color-ink-muted)]">
            Starting fresh instead?{' '}
            <Link href="/setup" className="font-medium text-[var(--color-accent)] hover:underline">
              Create an admin account
            </Link>
          </p>
        }
      />
    </>
  )
}
