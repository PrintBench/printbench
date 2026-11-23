'use client'

import { useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import * as Dialog from '@radix-ui/react-dialog'
import { Camera, ImagePlus, Loader2, Pencil, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { LocalTime } from '@/components/ui/local-time'
import { editPhoto, removePhoto } from './photo-actions'

/**
 * Photographs of what came off the plate.
 *
 * The upload posts to a route handler rather than a Server Action, because an
 * action's body is capped at a megabyte and a phone photograph is not. That
 * also gives the file input somewhere to send a real multipart body without
 * this component having to encode anything itself.
 *
 * Tiles link to the display rendition in a dialog rather than opening a new
 * tab: the point of the grid is comparing one print with the next, and losing
 * the page to do it is annoying.
 */

export const MAX_PHOTO_UPLOAD_BYTES = 25 * 1024 * 1024
const UNLINKED = ''

export interface PhotoView {
  id: string
  caption: string | null
  printRunId: string | null
  uploaderName: string | null
  width: number
  height: number
  createdAt: string
  canManage: boolean
}

export interface PhotoPrintOption {
  id: string
  label: string
}

interface Props {
  publicId: string
  photos: PhotoView[]
  prints: PhotoPrintOption[]
  canUpload: boolean
  /** Reached, the uploader says so instead of letting the server refuse. */
  full: boolean
}

export function ModelPhotos({ publicId, photos, prints, canUpload, full }: Props) {
  const router = useRouter()
  const fileInput = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<PhotoView | null>(null)
  const [viewing, setViewing] = useState<PhotoView | null>(null)
  const [pending, startTransition] = useTransition()

  const printLabel = new Map(prints.map((print) => [print.id, print.label]))

  async function upload(files: FileList) {
    setError(null)
    setUploading(true)

    try {
      // One request each, so a bad file in the middle of a selection does not
      // take the good ones down with it.
      for (const file of Array.from(files)) {
        if (file.size > MAX_PHOTO_UPLOAD_BYTES) {
          setError(`${file.name} is larger than 25 MB.`)
          continue
        }

        const body = new FormData()
        body.append('photo', file)

        const response = await fetch(`/api/models/${publicId}/photos`, { method: 'POST', body })
        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as { error?: string } | null
          setError(payload?.error ?? 'Could not upload that photo.')
          break
        }
      }
    } catch {
      setError('Could not upload that photo.')
    } finally {
      setUploading(false)
      if (fileInput.current) fileInput.current.value = ''
      router.refresh()
    }
  }

  function saveEdit(caption: string, printRunId: string | null) {
    if (!editing) return
    setError(null)
    startTransition(async () => {
      const result = await editPhoto(publicId, editing.id, { caption, printRunId })
      if (!result.ok) {
        setError(result.error)
        return
      }
      setEditing(null)
      router.refresh()
    })
  }

  function remove(photo: PhotoView) {
    if (!confirm('Delete this photo? This cannot be undone.')) return
    startTransition(async () => {
      const result = await removePhoto(publicId, photo.id)
      if (!result.ok) setError(result.error)
      else {
        setViewing(null)
        router.refresh()
      }
    })
  }

  if (photos.length === 0 && !canUpload) return null

  return (
    <section>
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <Camera className="size-4" />
          Photos
          {photos.length > 0 && (
            <span className="font-normal text-[var(--color-ink-faint)]">{photos.length}</span>
          )}
        </h2>

        {canUpload && (
          <div className="ml-auto">
            <input
              ref={fileInput}
              type="file"
              accept="image/*"
              multiple
              className="sr-only"
              onChange={(event) => {
                const files = event.target.files
                if (files && files.length > 0) void upload(files)
              }}
            />
            <Button
              variant="secondary"
              size="sm"
              disabled={uploading || full}
              title={full ? 'This model is holding as many photos as it can.' : undefined}
              onClick={() => fileInput.current?.click()}
            >
              {uploading ? <Loader2 className="animate-spin" /> : <ImagePlus />}
              {uploading ? 'Uploading…' : 'Add photos'}
            </Button>
          </div>
        )}
      </div>

      {error && <p className="mb-2 text-sm text-[var(--color-danger)]">{error}</p>}

      {photos.length === 0 ? (
        <Card>
          <CardContent className="p-4 text-sm text-[var(--color-ink-muted)]">
            No photos yet. Add one when something comes off the plate — it is the quickest way to
            tell two versions of a model apart later.
          </CardContent>
        </Card>
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {photos.map((photo) => (
            <li key={photo.id}>
              <button
                type="button"
                onClick={() => setViewing(photo)}
                className="group block w-full overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface-2)] text-left"
              >
                {/* eslint-disable-next-line @next/next/no-img-element --
                    next/image would proxy and re-encode something this route
                    has already sized and that nginx serves directly. */}
                <img
                  src={`/api/photos/${photo.id}/thumb`}
                  alt={photo.caption ?? 'Photo of this model'}
                  loading="lazy"
                  className="aspect-square w-full object-cover transition-opacity group-hover:opacity-90"
                />
                {photo.caption && (
                  <span className="block truncate px-2 py-1.5 text-xs text-[var(--color-ink-muted)]">
                    {photo.caption}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* Viewer */}
      <Dialog.Root open={viewing !== null} onOpenChange={(open) => !open && setViewing(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/70" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[92vh] w-[min(92vw,1100px)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-[var(--shadow-pop)]">
            <Dialog.Title className="sr-only">Photo</Dialog.Title>
            <Dialog.Description className="sr-only">
              A photograph attached to this model.
            </Dialog.Description>

            {viewing && (
              <>
                <div className="mb-3 flex items-center gap-2">
                  <p className="min-w-0 flex-1 truncate text-sm font-medium">
                    {viewing.caption ?? 'Untitled photo'}
                  </p>
                  {viewing.canManage && (
                    <>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={pending}
                        onClick={() => {
                          setEditing(viewing)
                          setViewing(null)
                        }}
                      >
                        <Pencil />
                        Edit
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={pending}
                        onClick={() => remove(viewing)}
                      >
                        <Trash2 />
                        Delete
                      </Button>
                    </>
                  )}
                  <Dialog.Close asChild>
                    <Button variant="ghost" size="icon" aria-label="Close">
                      <X />
                    </Button>
                  </Dialog.Close>
                </div>

                {/* eslint-disable-next-line @next/next/no-img-element -- see above */}
                <img
                  src={`/api/photos/${viewing.id}/image`}
                  alt={viewing.caption ?? 'Photo of this model'}
                  width={viewing.width}
                  height={viewing.height}
                  className="mx-auto h-auto max-h-[70vh] w-auto rounded-[var(--radius-control)]"
                />

                <p className="mt-3 flex flex-wrap items-center gap-2 text-xs text-[var(--color-ink-faint)]">
                  <span>{viewing.uploaderName ?? 'Someone no longer here'}</span>
                  <LocalTime value={viewing.createdAt} />
                  {viewing.printRunId && (
                    <Badge tone="accent">
                      {printLabel.get(viewing.printRunId) ?? 'A print of this model'}
                    </Badge>
                  )}
                </p>
              </>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* Caption and print link */}
      <Dialog.Root open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(92vw,480px)] -translate-x-1/2 -translate-y-1/2 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-[var(--shadow-pop)]">
            <Dialog.Title className="mb-3 text-sm font-semibold">Edit photo</Dialog.Title>
            <Dialog.Description className="sr-only">
              Change this photo&rsquo;s caption or the print it belongs to.
            </Dialog.Description>

            {editing && (
              <PhotoForm
                key={editing.id}
                photo={editing}
                prints={prints}
                pending={pending}
                error={error}
                onCancel={() => setEditing(null)}
                onSubmit={saveEdit}
              />
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </section>
  )
}

function PhotoForm({
  photo,
  prints,
  pending,
  error,
  onCancel,
  onSubmit,
}: {
  photo: PhotoView
  prints: PhotoPrintOption[]
  pending: boolean
  error: string | null
  onCancel: () => void
  onSubmit: (caption: string, printRunId: string | null) => void
}) {
  const [caption, setCaption] = useState(photo.caption ?? '')
  const [printRunId, setPrintRunId] = useState(photo.printRunId ?? UNLINKED)

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit(caption, printRunId === UNLINKED ? null : printRunId)
      }}
      className="space-y-3"
    >
      <Field label="Caption" htmlFor="photo-caption" error={error ?? undefined}>
        <Input
          value={caption}
          onChange={(event) => setCaption(event.target.value)}
          maxLength={300}
          placeholder="Second attempt, 0.2mm, bed at 65"
        />
      </Field>

      {prints.length > 0 && (
        <Field
          label="About a print"
          htmlFor="photo-print"
          hint="Leave this alone for a photo of the model itself."
        >
          <Select value={printRunId} onChange={(event) => setPrintRunId(event.target.value)}>
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
        <Button type="submit" size="sm" disabled={pending}>
          Save
        </Button>
        <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  )
}
