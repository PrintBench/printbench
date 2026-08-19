'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Check, Loader2, Pencil, Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Field } from '@/components/ui/field'
import { cn } from '@/lib/cn'
import { loadSuggestions, saveModel } from './edit-actions'

/**
 * Inline metadata editing.
 *
 * Opens in place rather than on a separate page: editing a model is something
 * you do while looking at it, and a round trip to a form loses that context.
 *
 * Common licences are offered as a list, because typing "CC-BY-NC-4.0" by hand
 * produces a facet full of near-miss variants that never group.
 */

const LICENCES = [
  'CC0-1.0',
  'CC-BY-4.0',
  'CC-BY-SA-4.0',
  'CC-BY-NC-4.0',
  'CC-BY-NC-SA-4.0',
  'CC-BY-ND-4.0',
  'MIT',
  'GPL-3.0-or-later',
  'Proprietary',
]

export interface ModelEditorProps {
  publicId: string
  initial: {
    name: string
    notes: string | null
    license: string | null
    creator: string | null
    tags: string[]
  }
  canEdit: boolean
}

export function ModelEditor({ publicId, initial, canEdit }: ModelEditorProps) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const [name, setName] = useState(initial.name)
  const [notes, setNotes] = useState(initial.notes ?? '')
  const [license, setLicense] = useState(initial.license ?? '')
  const [creator, setCreator] = useState(initial.creator ?? '')
  const [tags, setTags] = useState<string[]>(initial.tags)
  const [tagDraft, setTagDraft] = useState('')

  const [suggestions, setSuggestions] = useState<{ tags: string[]; creators: string[] }>({
    tags: [],
    creators: [],
  })
  const loaded = useRef(false)

  useEffect(() => {
    if (!open || loaded.current) return
    loaded.current = true
    void loadSuggestions().then(setSuggestions)
  }, [open])

  if (!canEdit) return null

  if (!open) {
    return (
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        <Pencil />
        Edit
      </Button>
    )
  }

  function addTag(value: string) {
    const cleaned = value.trim()
    if (!cleaned) return
    // Case-insensitive: "Dragon" and "dragon" must not become two tags, or the
    // facet splits and both halves become useless.
    if (tags.some((tag) => tag.toLowerCase() === cleaned.toLowerCase())) {
      setTagDraft('')
      return
    }
    setTags((current) => [...current, cleaned])
    setTagDraft('')
  }

  async function save() {
    setSaving(true)
    setError(null)
    setNote(null)
    try {
      const result = await saveModel(publicId, {
        name,
        notes: notes.trim() === '' ? null : notes,
        license: license.trim() === '' ? null : license,
        creator: creator.trim() === '' ? null : creator,
        tags,
      })
      if (!result.ok) {
        setError(result.error)
        return
      }
      setNote(
        result.sidecarWritten
          ? 'Saved, and written to the folder so it survives a database loss.'
          : 'Saved.',
      )
      setOpen(false)
      router.refresh()
    } finally {
      setSaving(false)
    }
  }

  const unusedTagSuggestions = suggestions.tags
    .filter((tag) => !tags.some((existing) => existing.toLowerCase() === tag.toLowerCase()))
    .slice(0, 10)

  return (
    <div className="space-y-4 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      <Field label="Name" htmlFor="model-name">
        <Input value={name} onChange={(event) => setName(event.target.value)} />
      </Field>

      <Field label="Notes" htmlFor="model-notes">
        <textarea
          id="model-notes"
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          rows={4}
          className="w-full rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface)] p-2 text-sm focus:border-[var(--color-accent)]"
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Creator" htmlFor="model-creator" hint="Created if it does not exist yet.">
          <Input
            value={creator}
            list="creator-suggestions"
            onChange={(event) => setCreator(event.target.value)}
          />
        </Field>
        <datalist id="creator-suggestions">
          {suggestions.creators.map((option) => (
            <option key={option} value={option} />
          ))}
        </datalist>

        <Field
          label="Licence"
          htmlFor="model-license"
          hint="Pick a standard identifier so licences group together."
        >
          <Input
            value={license}
            list="license-suggestions"
            onChange={(event) => setLicense(event.target.value)}
          />
        </Field>
        <datalist id="license-suggestions">
          {LICENCES.map((option) => (
            <option key={option} value={option} />
          ))}
        </datalist>
      </div>

      <div className="space-y-1.5">
        <span className="block text-sm font-medium">Tags</span>

        <div className="flex flex-wrap gap-1.5">
          {tags.map((tag) => (
            <span
              key={tag}
              className="inline-flex items-center gap-1 rounded-full bg-[var(--color-accent-soft)] py-0.5 pl-2.5 pr-1 text-xs font-medium text-[var(--color-accent)]"
            >
              {tag}
              <button
                type="button"
                aria-label={`Remove tag ${tag}`}
                onClick={() => setTags((current) => current.filter((item) => item !== tag))}
                className="rounded-full p-0.5 hover:bg-[var(--color-accent)]/15"
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>

        <Input
          value={tagDraft}
          placeholder="Add a tag and press Enter"
          onChange={(event) => setTagDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ',') {
              event.preventDefault()
              addTag(tagDraft)
            } else if (event.key === 'Backspace' && tagDraft === '') {
              setTags((current) => current.slice(0, -1))
            }
          }}
        />

        {unusedTagSuggestions.length > 0 && (
          <div className="flex flex-wrap gap-1 pt-1">
            {unusedTagSuggestions.map((tag) => (
              <button
                key={tag}
                type="button"
                onClick={() => addTag(tag)}
                className={cn(
                  'inline-flex items-center gap-0.5 rounded-full border border-[var(--color-border)] px-2 py-0.5',
                  'text-xs text-[var(--color-ink-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]',
                )}
              >
                <Plus className="size-2.5" />
                {tag}
              </button>
            ))}
          </div>
        )}
      </div>

      {error && (
        <p role="alert" className="text-sm text-[var(--color-danger)]">
          {error}
        </p>
      )}
      {note && <p className="text-sm text-[var(--color-ink-muted)]">{note}</p>}

      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={saving}>
          Cancel
        </Button>
        <Button size="sm" onClick={() => void save()} disabled={saving || name.trim() === ''}>
          {saving ? <Loader2 className="animate-spin" /> : <Check />}
          Save
        </Button>
      </div>
    </div>
  )
}
