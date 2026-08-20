'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Check, Loader2 } from 'lucide-react'
import type { Settings } from '@pm/core'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Field } from '@/components/ui/field'
import { Card, CardContent } from '@/components/ui/card'
import { saveSettings } from './actions'

/**
 * The settings page, kept deliberately short.
 *
 * Each switch here is a decision someone has to understand. A self-hosted app
 * with forty of them is one nobody configures correctly, so anything that
 * belongs to a single library lives on that library instead.
 */
export function SettingsForm({ initial }: { initial: Settings }) {
  const router = useRouter()
  const [values, setValues] = useState<Settings>(initial)
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  function set<K extends keyof Settings>(key: K, value: Settings[K]) {
    setValues((current) => ({ ...current, [key]: value }))
    setSaved(false)
  }

  function submit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    startTransition(async () => {
      const result = await saveSettings(values)
      if (!result.ok) {
        setError(result.error)
        return
      }
      setSaved(true)
      router.refresh()
    })
  }

  return (
    <form onSubmit={submit} className="max-w-2xl space-y-4">
      <Card>
        <CardContent className="space-y-4 p-4">
          <h2 className="text-sm font-semibold">This instance</h2>

          <Field label="Name" htmlFor="site-name" hint="Shown in the sidebar and the browser tab.">
            <Input value={values.siteName} onChange={(e) => set('siteName', e.target.value)} />
          </Field>

          <Field
            label="New accounts start as"
            htmlFor="default-role"
            hint="Viewers can browse and download. Members can also edit, upload and log prints."
          >
            <Select
              value={values.defaultRole}
              onChange={(e) => set('defaultRole', e.target.value as Settings['defaultRole'])}
            >
              <option value="viewer">Viewer</option>
              <option value="member">Member</option>
            </Select>
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-4 p-4">
          <h2 className="text-sm font-semibold">Safety</h2>

          <Field
            label="Keep missing models for"
            htmlFor="grace-days"
            hint="A model whose files vanish is kept this long before it can be removed. This is what makes an unmounted drive recoverable — shorten it with care."
          >
            <div className="flex items-center gap-2">
              <Input
                type="number"
                min={1}
                max={365}
                value={values.missingGraceDays}
                onChange={(e) => set('missingGraceDays', Number(e.target.value))}
                className="w-28"
              />
              <span className="text-sm text-[var(--color-ink-muted)]">days</span>
            </div>
          </Field>

          <Toggle
            label="Write metadata back to disk"
            hint="Keeps a .printmanager.json beside each model in writable libraries, so tags, creator and licence survive losing the database. Never touches your model files."
            checked={values.writeSidecars}
            onChange={(value) => set('writeSidecars', value)}
          />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-4 p-4">
          <h2 className="text-sm font-semibold">Browsing</h2>

          <Field
            label="Load meshes in the viewer up to"
            htmlFor="viewer-max"
            hint="Larger models show their thumbnail instead, with the option to load anyway. Raise it if you have the memory."
          >
            <div className="flex items-center gap-2">
              <Input
                type="number"
                min={1}
                value={Math.round(values.viewerMaxBytes / (1024 * 1024))}
                onChange={(e) => set('viewerMaxBytes', Number(e.target.value) * 1024 * 1024)}
                className="w-28"
              />
              <span className="text-sm text-[var(--color-ink-muted)]">MB</span>
            </div>
          </Field>

          <Toggle
            label="Track metadata problems"
            hint="Reports models with no licence, creator, tags or preview on the health page. Turn off if you do not curate that far — the important checks keep running either way."
            checked={values.trackMetadataProblems}
            onChange={(value) => set('trackMetadataProblems', value)}
          />

          <Toggle
            label="Allow share links"
            hint="Lets a signed-out visitor open a model you have explicitly shared. Off means the instance is entirely private."
            checked={values.publicSharing}
            onChange={(value) => set('publicSharing', value)}
          />
        </CardContent>
      </Card>

      {error && <p className="text-sm text-[var(--color-danger)]">{error}</p>}

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending && <Loader2 className="animate-spin" />}
          Save settings
        </Button>
        {saved && !pending && (
          <span className="flex items-center gap-1.5 text-sm text-[var(--color-success)]">
            <Check className="size-4" />
            Saved
          </span>
        )}
      </div>
    </form>
  )
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string
  hint: string
  checked: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1"
      />
      <span className="min-w-0">
        <span className="block text-sm font-medium text-[var(--color-ink)]">{label}</span>
        <span className="block text-xs text-[var(--color-ink-faint)]">{hint}</span>
      </span>
    </label>
  )
}
