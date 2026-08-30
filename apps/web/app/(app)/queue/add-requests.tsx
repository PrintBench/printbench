'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, Plus, X } from 'lucide-react'
import { MAX_BULK_REQUESTS, parseRequestLines, type PrintRequestPriority } from '@pb/core/requests'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { addRequests } from './actions'

/**
 * Adding a batch.
 *
 * Requests arrive as a message — "the dragon, two cable clips and something to
 * hold the kitchen roll" — so the box takes the message. One line becomes one
 * request, and everything alongside it (who asked, when they need it) is set
 * once for the whole batch rather than repeated per row.
 *
 * The preview underneath is the important part: line parsing has rules, and
 * rules the user cannot see are rules they cannot trust. Showing the split
 * before it is saved turns "x4" from a guess into something they watched work.
 */
export function AddRequests({ requesterSuggestions }: { requesterSuggestions: string[] }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [requestedBy, setRequestedBy] = useState('')
  const [priority, setPriority] = useState<PrintRequestPriority>('normal')
  const [dueAt, setDueAt] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  // The same parser the server will use, so the preview cannot disagree with
  // what gets saved.
  const parsed = useMemo(() => parseRequestLines(text), [text])

  function submit() {
    setError(null)
    setNotice(null)

    startTransition(async () => {
      const result = await addRequests({
        text,
        requestedBy,
        priority,
        dueAt: dueAt || null,
      })

      if (!result.ok) {
        setError(result.error)
        return
      }

      setNotice(summarise(result.created, result.autoLinked, result.skipped))
      setText('')
      setDueAt('')
      // The requester is kept: a batch is usually the start of a conversation
      // with one person, not the end of it.
      router.refresh()
    })
  }

  if (!open) {
    return (
      <Button onClick={() => setOpen(true)}>
        <Plus />
        Add requests
      </Button>
    )
  }

  return (
    <Card>
      <div className="space-y-4 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">Add to the queue</h2>
            <p className="mt-0.5 text-xs text-[var(--color-ink-muted)]">
              One thing per line. Add a count with &ldquo;x4&rdquo; at either end, and anything
              whose name matches a model exactly is linked to it automatically.
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Close"
            onClick={() => {
              setOpen(false)
              setError(null)
              setNotice(null)
            }}
          >
            <X />
          </Button>
        </div>

        <Field label="What needs printing" htmlFor="queue-lines">
          <textarea
            id="queue-lines"
            autoFocus
            rows={5}
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={'Articulated dragon\nCable clip x4\nSomething to hold the kitchen roll'}
            className="w-full rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-ink)] placeholder:text-[var(--color-ink-faint)] transition-colors focus:border-[var(--color-accent)]"
          />
        </Field>

        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Requested by" htmlFor="queue-requester" hint="Optional">
            <>
              <Input
                id="queue-requester"
                list="queue-requester-options"
                value={requestedBy}
                onChange={(event) => setRequestedBy(event.target.value)}
                placeholder="Whoever asked"
              />
              {/* Names already in the queue, so the third request from the
                  same person is a pick rather than a retype. */}
              <datalist id="queue-requester-options">
                {requesterSuggestions.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
            </>
          </Field>

          <Field label="Priority" htmlFor="queue-priority">
            <Select
              id="queue-priority"
              value={priority}
              onChange={(event) => setPriority(event.target.value as PrintRequestPriority)}
            >
              <option value="high">Urgent</option>
              <option value="normal">Normal</option>
              <option value="low">Whenever</option>
            </Select>
          </Field>

          <Field label="Needed by" htmlFor="queue-due" hint="Optional">
            <Input
              id="queue-due"
              type="date"
              value={dueAt}
              onChange={(event) => setDueAt(event.target.value)}
            />
          </Field>
        </div>

        {parsed.length > 0 && (
          <div className="rounded-[var(--radius-control)] bg-[var(--color-surface-2)] p-3">
            <p className="text-xs font-medium text-[var(--color-ink-muted)]">
              {parsed.length} request{parsed.length === 1 ? '' : 's'} will be added
              {parsed.length === MAX_BULK_REQUESTS && ' (the most that can go in at once)'}
            </p>
            <ul className="mt-1.5 space-y-0.5">
              {parsed.map((line, index) => (
                <li key={index} className="truncate text-xs text-[var(--color-ink)]">
                  {line.title}
                  {line.quantity > 1 && (
                    <span className="text-[var(--color-ink-faint)]"> × {line.quantity}</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {error && <p className="text-sm text-[var(--color-danger)]">{error}</p>}
        {notice && <p className="text-sm text-[var(--color-success)]">{notice}</p>}

        <div className="flex items-center gap-2">
          <Button disabled={pending || parsed.length === 0} onClick={submit}>
            {pending ? <Loader2 className="animate-spin" /> : <Plus />}
            Add {parsed.length > 0 ? parsed.length : ''} to queue
          </Button>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Done
          </Button>
        </div>
      </div>
    </Card>
  )
}

function summarise(created: number, autoLinked: number, skipped: string[]): string {
  const parts = [`Added ${created} request${created === 1 ? '' : 's'}`]
  if (autoLinked > 0) parts.push(`${autoLinked} linked to your library`)
  if (skipped.length > 0) parts.push(`${skipped.length} could not be added`)
  return `${parts.join(' · ')}.`
}
