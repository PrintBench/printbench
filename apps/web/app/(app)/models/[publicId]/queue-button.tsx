'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Check, ClipboardList, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Field } from '@/components/ui/field'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { addModelToQueue } from '../../queue/actions'

/**
 * Queues this model from its own page.
 *
 * The reverse of the queue's link picker, and the direction people actually
 * travel most: you are already looking at the thing when you decide it needs
 * printing, and going to another page to retype its name is how a queue stops
 * being used.
 */
export function QueueButton({
  modelId,
  modelPublicId,
  modelName,
  openCount,
}: {
  modelId: string
  modelPublicId: string
  modelName: string
  /** Requests already open against this model. */
  openCount: number
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [requestedBy, setRequestedBy] = useState('')
  const [quantity, setQuantity] = useState('1')
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function submit() {
    setError(null)
    startTransition(async () => {
      const result = await addModelToQueue({
        modelId,
        modelPublicId,
        title: modelName,
        quantity: Number(quantity) || 1,
        requestedBy,
      })

      if (!result.ok) {
        setError(result.error)
        return
      }

      setOpen(false)
      setRequestedBy('')
      setQuantity('1')
      router.refresh()
    })
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label={
            openCount > 0
              ? `Print queue — ${openCount} open for this model`
              : 'Add this model to the print queue'
          }
        >
          <ClipboardList />
          <span className="hidden sm:inline">
            {/* The count is the useful part when there is one: it says someone
                is already waiting, which changes whether you add another. */}
            {openCount > 0 ? `Queued (${openCount})` : 'Queue'}
          </span>
        </Button>
      </PopoverTrigger>

      <PopoverContent className="w-72 p-3">
        <div className="space-y-3">
          <p className="text-sm font-medium">Add to the print queue</p>

          {openCount > 0 && (
            <p className="text-xs text-[var(--color-ink-muted)]">
              {openCount === 1 ? 'One request is' : `${openCount} requests are`} already open for
              this model.{' '}
              <Link href="/queue" className="text-[var(--color-accent)] hover:underline">
                See the queue
              </Link>
            </p>
          )}

          <div className="grid grid-cols-[1fr_5rem] gap-2">
            <Field label="Requested by" htmlFor="queue-model-requester">
              <Input
                id="queue-model-requester"
                autoFocus
                value={requestedBy}
                onChange={(event) => setRequestedBy(event.target.value)}
                onKeyDown={(event) => event.key === 'Enter' && submit()}
                placeholder="Optional"
                className="h-9"
              />
            </Field>

            <Field label="How many" htmlFor="queue-model-quantity">
              <Input
                id="queue-model-quantity"
                type="number"
                min={1}
                max={999}
                value={quantity}
                onChange={(event) => setQuantity(event.target.value)}
                onKeyDown={(event) => event.key === 'Enter' && submit()}
                className="h-9"
              />
            </Field>
          </div>

          {error && <p className="text-xs text-[var(--color-danger)]">{error}</p>}

          <Button size="sm" disabled={pending} onClick={submit} className="w-full">
            {pending ? <Loader2 className="animate-spin" /> : <Check />}
            Add to queue
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
