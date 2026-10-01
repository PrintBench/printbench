'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Check, Loader2, Pencil, Plus, X } from 'lucide-react'
import * as Dialog from '@radix-ui/react-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Field } from '@/components/ui/field'
import { cn } from '@/lib/cn'
import { loadSuggestions, saveModel } from './edit-actions'

/**
 * Model metadata editor.
 *
 * Opens in a modal dialog over the model detail page so the user can edit
 * metadata without navigating away from the model they are viewing.
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

const LINK_TYPES = [
  'Original model page',
  'Assembly video',
  'Printing instructions',
  'Designer page',
] as const

type ModelLink = {
  title: string
  url: string
}

export interface ModelEditorProps {
  publicId: string
  initial: {
    name: string
    notes: string | null
    license: string | null
    licenseUrl: string | null
    licenseExpiresAt: string | null
    commercialUse: boolean | null
    licenseNotes: string | null
    creator: string | null
    tags: string[]
    links: { title: string | null; url: string }[]
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
  const [licenseUrl, setLicenseUrl] = useState(initial.licenseUrl ?? '')
  const [licenseExpiresAt, setLicenseExpiresAt] = useState(initial.licenseExpiresAt ?? '')
  const [commercialUse, setCommercialUse] = useState<'unknown' | 'yes' | 'no'>(
    initial.commercialUse === true ? 'yes' : initial.commercialUse === false ? 'no' : 'unknown',
  )
  const [licenseNotes, setLicenseNotes] = useState(initial.licenseNotes ?? '')
  const [creator, setCreator] = useState(initial.creator ?? '')
  const [tags, setTags] = useState<string[]>(initial.tags)
  const [tagDraft, setTagDraft] = useState('')
  const [links, setLinks] = useState<ModelLink[]>(
    initial.links.map((link) => ({
      title: link.title ?? '',
      url: link.url,
    })),
  )

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
        licenseUrl: licenseUrl.trim() === '' ? null : licenseUrl,
        licenseExpiresAt: licenseExpiresAt.trim() === '' ? null : licenseExpiresAt,
        commercialUse: commercialUse === 'yes' ? true : commercialUse === 'no' ? false : null,
        licenseNotes: licenseNotes.trim() === '' ? null : licenseNotes,
        creator: creator.trim() === '' ? null : creator,
        tags,
        links: links
          .map((link) => ({
            title: link.title.trim() === '' ? null : link.title.trim(),
            url: link.url.trim(),
          }))
          .filter((link) => link.url !== ''),
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
    <Dialog.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && saving) return
        setOpen(nextOpen)
      }}
    >
      <Dialog.Trigger asChild>
        <Button variant="secondary" size="sm">
          <Pencil />
          Edit
        </Button>
      </Dialog.Trigger>

      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />

        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 max-h-[90vh] w-[calc(100%-2rem)] max-w-4xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] p-5 shadow-xl"
          onEscapeKeyDown={(event) => {
            if (saving) event.preventDefault()
          }}
          onPointerDownOutside={(event) => {
            if (saving) event.preventDefault()
          }}
        >
          <Dialog.Title className="sr-only">Edit model</Dialog.Title>
          <Dialog.Description className="sr-only">Edit this model's metadata.</Dialog.Description>

          <div className="space-y-4">
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
              <Field
                label="Creator"
                htmlFor="model-creator"
                hint="Created if it does not exist yet."
              >
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

            <Field
              label="Licence URL"
              htmlFor="model-license-url"
              hint="Link to the licence terms or commercial subscription page."
            >
              <Input
                id="model-license-url"
                type="url"
                value={licenseUrl}
                placeholder="https://..."
                onChange={(event) => setLicenseUrl(event.target.value)}
              />
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Commercial use" htmlFor="model-commercial-use">
                <Select
                  id="model-commercial-use"
                  value={commercialUse}
                  onChange={(event) =>
                    setCommercialUse(event.target.value as 'unknown' | 'yes' | 'no')
                  }
                >
                  <option value="unknown">Not recorded</option>
                  <option value="yes">Licensed for commercial use</option>
                  <option value="no">Commercial use not permitted</option>
                </Select>
              </Field>

              <Field
                label="Licence expiry"
                htmlFor="model-license-expiry"
                hint="Leave blank if the licence does not expire."
              >
                <Input
                  id="model-license-expiry"
                  type="date"
                  value={licenseExpiresAt}
                  onChange={(event) => setLicenseExpiresAt(event.target.value)}
                />
              </Field>
            </div>

            <Field
              label="Licence notes"
              htmlFor="model-license-notes"
              hint="Attribution, modification restrictions, or other important terms."
            >
              <textarea
                id="model-license-notes"
                value={licenseNotes}
                onChange={(event) => setLicenseNotes(event.target.value)}
                rows={3}
                className="w-full rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface)] p-2 text-sm focus:border-[var(--color-accent)]"
              />
            </Field>

            <div className="space-y-2 border-y-2 border-[var(--color-border)] py-4">
              <div>
                <span className="block text-sm font-medium">Links</span>
                <span className="text-xs text-[var(--color-text-muted)]">
                  Add source pages, videos, instructions, designer pages, or other useful links.
                </span>
              </div>

              <div className="divide-y divide-[var(--color-border)]">
                {links.map((link, index) => {
                  const knownType = LINK_TYPES.includes(link.title as (typeof LINK_TYPES)[number])
                  const selectedType = knownType ? link.title : 'Other'

                  return (
                    <div key={index} className="py-2 first:pt-0">
                      <div
                        className={cn(
                          'grid gap-2',
                          knownType
                            ? 'sm:grid-cols-[190px_1fr_auto]'
                            : 'sm:grid-cols-[190px_200px_1fr_auto]',
                        )}
                      >
                        <Select
                          id={`model-link-type-${index}`}
                          aria-label={`Link ${index + 1} type`}
                          value={selectedType}
                          onChange={(event) => {
                            const value = event.target.value
                            setLinks((current) =>
                              current.map((item, itemIndex) =>
                                itemIndex === index
                                  ? {
                                      ...item,
                                      title: value === 'Other' ? '' : value,
                                    }
                                  : item,
                              ),
                            )
                          }}
                        >
                          {LINK_TYPES.map((type) => (
                            <option key={type} value={type}>
                              {type}
                            </option>
                          ))}
                          <option value="Other">Other</option>
                        </Select>

                        {!knownType && (
                          <Input
                            id={`model-link-title-${index}`}
                            aria-label={`Link ${index + 1} title`}
                            value={link.title}
                            placeholder="Link title"
                            onChange={(event) => {
                              const value = event.target.value
                              setLinks((current) =>
                                current.map((item, itemIndex) =>
                                  itemIndex === index ? { ...item, title: value } : item,
                                ),
                              )
                            }}
                          />
                        )}

                        <Input
                          id={`model-link-url-${index}`}
                          type="url"
                          aria-label={`Link ${index + 1} URL`}
                          value={link.url}
                          placeholder="https://..."
                          onChange={(event) => {
                            const value = event.target.value
                            setLinks((current) =>
                              current.map((item, itemIndex) =>
                                itemIndex === index ? { ...item, url: value } : item,
                              ),
                            )
                          }}
                        />

                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          aria-label="Remove link"
                          onClick={() =>
                            setLinks((current) =>
                              current.filter((_, itemIndex) => itemIndex !== index),
                            )
                          }
                        >
                          <X />
                        </Button>
                      </div>
                    </div>
                  )
                })}
              </div>

              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setLinks((current) => [...current, { title: '', url: '' }])}
              >
                <Plus />
                Add link
              </Button>
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
              <Dialog.Close asChild>
                <Button variant="ghost" size="sm" disabled={saving}>
                  Cancel
                </Button>
              </Dialog.Close>
              <Button size="sm" onClick={() => void save()} disabled={saving || name.trim() === ''}>
                {saving ? <Loader2 className="animate-spin" /> : <Check />}
                Save
              </Button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
