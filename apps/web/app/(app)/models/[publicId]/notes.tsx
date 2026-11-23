'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { NotebookPen, Pencil, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Field } from '@/components/ui/field'
import { Select } from '@/components/ui/select'
import { LocalTime } from '@/components/ui/local-time'
import { addNote, editNote, removeNote } from './note-actions'

/**
 * The model's working notes: what went wrong, what fixed it, what to do
 * differently next time.
 *
 * Distinct from the model's description, which is one field describing what
 * the thing is. This is a log, so each entry keeps its own author and date and
 * nothing overwrites what came before.
 *
 * A note may name a print and may equally name none. "No particular print" is
 * the default, because the advice worth keeping ("print the hinge face down")
 * usually outlives the run that taught it.
 */

export const NOTE_MAX_LENGTH = 4000

export interface NoteView {
  id: string
  body: string
  printRunId: string | null
  authorName: string | null
  /** ISO strings: a Date cannot cross the server/client boundary intact. */
  createdAt: string
  updatedAt: string
  /** True when the signed-in user may edit or delete this one. */
  canManage: boolean
}

export interface NotePrintOption {
  id: string
  label: string
}

interface Props {
  publicId: string
  notes: NoteView[]
  /** Prints of this model, newest first, for the optional link. */
  prints: NotePrintOption[]
  canCreate: boolean
}

const UNLINKED = ''

export function ModelNotes({ publicId, notes, prints, canCreate }: Props) {
  const router = useRouter()
  const [adding, setAdding] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const printLabel = new Map(prints.map((print) => [print.id, print.label]))

  function close() {
    setAdding(false)
    setEditingId(null)
    setError(null)
  }

  function save(body: string, printRunId: string | null, noteId?: string) {
    setError(null)
    startTransition(async () => {
      const result = noteId
        ? await editNote(publicId, noteId, { body, printRunId })
        : await addNote(publicId, { body, printRunId })

      if (!result.ok) {
        setError(result.error)
        return
      }
      close()
      router.refresh()
    })
  }

  function remove(noteId: string) {
    if (!confirm('Delete this note? This cannot be undone.')) return
    startTransition(async () => {
      const result = await removeNote(publicId, noteId)
      if (!result.ok) setError(result.error)
      else router.refresh()
    })
  }

  // Nothing to show and nothing to add: do not take up a heading.
  if (notes.length === 0 && !canCreate) return null

  return (
    <section>
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <NotebookPen className="size-4" />
          Notes
          {notes.length > 0 && (
            <span className="font-normal text-[var(--color-ink-faint)]">{notes.length}</span>
          )}
        </h2>
        {canCreate && !adding && (
          <Button variant="secondary" size="sm" className="ml-auto" onClick={() => setAdding(true)}>
            <Plus />
            Add a note
          </Button>
        )}
      </div>

      {error && !adding && !editingId && (
        <p className="mb-2 text-sm text-[var(--color-danger)]">{error}</p>
      )}

      {adding && (
        <Card className="mb-3">
          <CardContent className="p-4">
            <NoteForm
              prints={prints}
              pending={pending}
              error={error}
              onCancel={close}
              onSubmit={(body, printRunId) => save(body, printRunId)}
            />
          </CardContent>
        </Card>
      )}

      {notes.length === 0 && !adding ? (
        <Card>
          <CardContent className="p-4 text-sm text-[var(--color-ink-muted)]">
            Nothing noted yet. Problems, fixes and settings worth remembering go here — tie one to a
            print, or leave it against the model.
          </CardContent>
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-[var(--color-border)]">
            {notes.map((note) =>
              editingId === note.id ? (
                <li key={note.id} className="p-4">
                  <NoteForm
                    prints={prints}
                    pending={pending}
                    error={error}
                    initial={note}
                    onCancel={close}
                    onSubmit={(body, printRunId) => save(body, printRunId, note.id)}
                  />
                </li>
              ) : (
                <li key={note.id} className="p-4">
                  <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[var(--color-ink-faint)]">
                    <span className="font-medium text-[var(--color-ink-muted)]">
                      {note.authorName ?? 'Someone no longer here'}
                    </span>
                    <LocalTime value={note.createdAt} />
                    {note.updatedAt !== note.createdAt && <span>· edited</span>}
                    {note.printRunId && (
                      <Badge tone="accent">
                        {printLabel.get(note.printRunId) ?? 'A print of this model'}
                      </Badge>
                    )}

                    {note.canManage && (
                      <span className="ml-auto flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={pending}
                          onClick={() => {
                            setAdding(false)
                            setError(null)
                            setEditingId(note.id)
                          }}
                        >
                          <Pencil />
                          <span className="sr-only">Edit this note</span>
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={pending}
                          onClick={() => remove(note.id)}
                        >
                          <Trash2 />
                          <span className="sr-only">Delete this note</span>
                        </Button>
                      </span>
                    )}
                  </div>

                  <p className="whitespace-pre-wrap break-words text-sm">{note.body}</p>
                </li>
              ),
            )}
          </ul>
        </Card>
      )}
    </section>
  )
}

function NoteForm({
  prints,
  initial,
  pending,
  error,
  onCancel,
  onSubmit,
}: {
  prints: NotePrintOption[]
  initial?: NoteView
  pending: boolean
  error: string | null
  onCancel: () => void
  onSubmit: (body: string, printRunId: string | null) => void
}) {
  const [body, setBody] = useState(initial?.body ?? '')
  const [printRunId, setPrintRunId] = useState(initial?.printRunId ?? UNLINKED)

  const id = initial ? `note-${initial.id}` : 'note-new'

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit(body, printRunId === UNLINKED ? null : printRunId)
      }}
      className="space-y-3"
    >
      <Field
        label="Note"
        htmlFor={`${id}-body`}
        hint="What happened, and what you did about it."
        error={error ?? undefined}
      >
        <textarea
          id={`${id}-body`}
          value={body}
          onChange={(event) => setBody(event.target.value)}
          rows={4}
          maxLength={NOTE_MAX_LENGTH}
          autoFocus
          placeholder="First one warped off the bed at 40mm. Raised the bed to 65 and added a brim; second came out clean."
          className="w-full rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-ink)] placeholder:text-[var(--color-ink-faint)] focus:border-[var(--color-accent)]"
        />
      </Field>

      {/* Only offered when there is a print to pick. An empty dropdown reads
          as something broken rather than something optional. */}
      {prints.length > 0 && (
        <Field
          label="About a print"
          htmlFor={`${id}-print`}
          hint="Leave this alone for a note about the model itself."
        >
          <Select
            id={`${id}-print`}
            value={printRunId}
            onChange={(event) => setPrintRunId(event.target.value)}
          >
            <option value={UNLINKED}>No particular print</option>
            {prints.map((print) => (
              <option key={print.id} value={print.id}>
                {print.label}
              </option>
            ))}
          </Select>
        </Field>
      )}

      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={pending || body.trim().length === 0}>
          {initial ? 'Save note' : 'Add note'}
        </Button>
        <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  )
}
