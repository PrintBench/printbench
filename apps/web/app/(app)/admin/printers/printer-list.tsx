'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { CheckCircle2, Loader2, Pencil, Plug, Plus, Printer, Trash2, XCircle } from 'lucide-react'
import type { PrintHostProtocol } from '@pm/core'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Field } from '@/components/ui/field'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/empty-state'
import {
  createPrintHost,
  deletePrintHost,
  testPrintHost,
  updatePrintHost,
  type PrintHostInput,
} from './actions'

export interface PrintHostView {
  id: string
  name: string
  protocol: PrintHostProtocol
  endpoint: string
  hasApiKey: boolean
  lastSeenOk: string | null
}

const PROTOCOLS: { value: PrintHostProtocol; label: string; hint: string }[] = [
  {
    value: 'octoprint',
    label: 'OctoPrint',
    hint: 'The API key is under Settings → Application Keys.',
  },
  {
    value: 'moonraker',
    label: 'Moonraker (Klipper / Fluidd / Mainsail)',
    hint: 'Usually needs no key on a trusted LAN.',
  },
  {
    value: 'prusalink',
    label: 'PrusaLink (Prusa MK4, XL, Mini)',
    hint: 'The key is on the printer under Settings → Network.',
  },
]

export function PrinterList({ hosts }: { hosts: PrintHostView[] }) {
  const router = useRouter()
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<PrintHostView | null>(null)
  const [probe, setProbe] = useState<Record<string, string>>({})
  const [pending, startTransition] = useTransition()

  function test(host: PrintHostView) {
    setProbe((current) => ({ ...current, [host.id]: 'Checking…' }))
    startTransition(async () => {
      const result = await testPrintHost(host.id)
      setProbe((current) => ({
        ...current,
        [host.id]: result.ok
          ? `Reachable${result.version ? ` — ${result.version}` : ''}${result.state ? ` (${result.state})` : ''}`
          : result.error,
      }))
      router.refresh()
    })
  }

  function remove(host: PrintHostView) {
    if (!confirm(`Remove ${host.name}? Print history is not affected.`)) return
    startTransition(async () => {
      await deletePrintHost(host.id)
      router.refresh()
    })
  }

  return (
    <div className="space-y-4">
      {!adding && !editing && (
        <Button size="sm" onClick={() => setAdding(true)}>
          <Plus />
          Add a printer
        </Button>
      )}

      {(adding || editing) && (
        <Card>
          <CardContent className="p-4">
            <PrinterForm
              key={editing?.id ?? 'new'}
              host={editing}
              onDone={() => {
                setAdding(false)
                setEditing(null)
                router.refresh()
              }}
              onCancel={() => {
                setAdding(false)
                setEditing(null)
              }}
            />
          </CardContent>
        </Card>
      )}

      {hosts.length === 0 && !adding ? (
        <EmptyState
          icon={<Printer className="size-6" />}
          title="No printers yet"
          description="Add an OctoPrint, Moonraker or PrusaLink address and you can send sliced files straight from a model page."
        />
      ) : (
        <div className="grid gap-3">
          {hosts.map((host) => (
            <Card key={host.id}>
              <CardContent className="flex flex-wrap items-center gap-3 p-4">
                <Printer className="size-4 shrink-0 text-[var(--color-ink-faint)]" />

                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 text-sm font-medium">
                    {host.name}
                    <Badge tone="neutral">
                      {PROTOCOLS.find((p) => p.value === host.protocol)?.label.split(' ')[0] ??
                        host.protocol}
                    </Badge>
                    {host.hasApiKey && <Badge tone="neutral">key stored</Badge>}
                  </p>
                  <p className="truncate font-mono text-xs text-[var(--color-ink-muted)]">
                    {host.endpoint}
                  </p>
                  {probe[host.id] && (
                    <p className="mt-1 flex items-center gap-1.5 text-xs">
                      {probe[host.id] === 'Checking…' ? (
                        <Loader2 className="size-3 animate-spin" />
                      ) : probe[host.id]!.startsWith('Reachable') ? (
                        <CheckCircle2 className="size-3 text-[var(--color-success)]" />
                      ) : (
                        <XCircle className="size-3 text-[var(--color-danger)]" />
                      )}
                      {probe[host.id]}
                    </p>
                  )}
                  {!probe[host.id] && host.lastSeenOk && (
                    <p className="mt-1 text-xs text-[var(--color-ink-faint)]">
                      Last reachable {new Date(host.lastSeenOk).toLocaleString('en-GB')}
                    </p>
                  )}
                </div>

                <div className="flex shrink-0 gap-1">
                  <Button variant="ghost" size="sm" onClick={() => test(host)} disabled={pending}>
                    <Plug />
                    Test
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Edit ${host.name}`}
                    onClick={() => {
                      setEditing(host)
                      setAdding(false)
                    }}
                  >
                    <Pencil />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove ${host.name}`}
                    onClick={() => remove(host)}
                  >
                    <Trash2 />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}

function PrinterForm({
  host,
  onDone,
  onCancel,
}: {
  host: PrintHostView | null
  onDone: () => void
  onCancel: () => void
}) {
  const [name, setName] = useState(host?.name ?? '')
  const [protocol, setProtocol] = useState<PrintHostProtocol>(host?.protocol ?? 'octoprint')
  const [endpoint, setEndpoint] = useState(host?.endpoint ?? '')
  const [apiKey, setApiKey] = useState('')
  const [clearKey, setClearKey] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function submit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)

    /*
     * The stored key is never sent to the browser, so a blank field means "keep
     * what is there" rather than "remove it" — otherwise renaming a printer
     * would silently wipe its credential. Removing takes an explicit tick.
     */
    const input: PrintHostInput = {
      name,
      protocol,
      endpoint,
      apiKey: clearKey ? '' : apiKey ? apiKey : host ? undefined : '',
    }

    startTransition(async () => {
      const result = host ? await updatePrintHost(host.id, input) : await createPrintHost(input)
      if (!result.ok) setError(result.error)
      else onDone()
    })
  }

  const selected = PROTOCOLS.find((p) => p.value === protocol)!

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" htmlFor="host-name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Workshop MK4" />
        </Field>

        <Field label="Type" htmlFor="host-protocol" hint={selected.hint}>
          <Select
            value={protocol}
            onChange={(e) => setProtocol(e.target.value as PrintHostProtocol)}
          >
            {PROTOCOLS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          label="Address"
          htmlFor="host-endpoint"
          hint="Include http:// — for example http://octopi.local or http://192.168.1.42"
        >
          <Input
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            placeholder="http://octopi.local"
            autoComplete="off"
          />
        </Field>

        <Field
          label="API key"
          htmlFor="host-key"
          hint={host?.hasApiKey ? 'Leave blank to keep the stored key.' : 'Optional on a trusted LAN.'}
        >
          <Input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            disabled={clearKey}
            autoComplete="new-password"
            placeholder={host?.hasApiKey ? '••••••••' : ''}
          />
        </Field>
      </div>

      {host?.hasApiKey && (
        <label className="flex items-center gap-2 text-sm text-[var(--color-ink-muted)]">
          <input
            type="checkbox"
            checked={clearKey}
            onChange={(e) => setClearKey(e.target.checked)}
          />
          Remove the stored API key
        </label>
      )}

      {error && <p className="text-sm text-[var(--color-danger)]">{error}</p>}

      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {pending && <Loader2 className="animate-spin" />}
          {host ? 'Save' : 'Add printer'}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
      </div>
    </form>
  )
}
