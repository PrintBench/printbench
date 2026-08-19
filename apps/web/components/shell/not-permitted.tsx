import Link from 'next/link'
import { Lock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'

/**
 * Shown when a signed-in user reaches a page their role does not allow.
 * A refusal should be a normal, legible screen — not a 500.
 */
export function NotPermitted({ what = 'this page' }: { what?: string }) {
  return (
    <EmptyState
      icon={<Lock />}
      title="You don't have access"
      description={`Your account doesn't have permission to view ${what}. An admin can change your role.`}
      action={
        <Button asChild variant="secondary">
          <Link href="/">Back to dashboard</Link>
        </Button>
      }
    />
  )
}
