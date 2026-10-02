'use client'

import { useState } from 'react'
import { Box, ImageIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { ModelViewer, type ModelViewerProps } from './model-viewer'

export interface ModelPreviewProps {
  name: string
  imageUrl: string | null
  model: Omit<ModelViewerProps, 'active' | 'className'> | null
  preferImage?: boolean
}

/** Keep the loaded viewer and camera while switching back to the artwork. */
export function ModelPreview({ name, imageUrl, model, preferImage = false }: ModelPreviewProps) {
  const initialView = imageUrl && (preferImage || !model) ? 'image' : 'model'
  const [view, setView] = useState<'image' | 'model'>(initialView)
  const [modelVisited, setModelVisited] = useState(initialView === 'model')

  return (
    <section aria-label={`Preview of ${name}`} className="space-y-3">
      {imageUrl && model && (
        <div role="group" aria-label="Preview mode" className="flex gap-2">
          <Button
            type="button"
            variant={view === 'image' ? 'primary' : 'secondary'}
            aria-pressed={view === 'image'}
            onClick={() => setView('image')}
          >
            <ImageIcon />
            Thumbnail
          </Button>
          <Button
            type="button"
            variant={view === 'model' ? 'primary' : 'secondary'}
            aria-pressed={view === 'model'}
            onClick={() => {
              setModelVisited(true)
              setView('model')
            }}
          >
            <Box />
            3D model
          </Button>
        </div>
      )}
      {imageUrl && (
        <div hidden={view !== 'image'}>
          <Card className="overflow-hidden">
            <div className="flex aspect-[16/10] items-center justify-center bg-[var(--color-surface-2)]">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={imageUrl}
                alt={`Thumbnail of ${name}`}
                className="size-full object-contain"
              />
            </div>
          </Card>
        </div>
      )}
      {model && modelVisited && (
        <div hidden={view !== 'model'}>
          <ModelViewer {...model} active={view === 'model'} className="aspect-[16/10]" />
          <p className="mt-2 text-xs text-[var(--color-ink-faint)]">
            Drag to rotate, scroll to zoom.
          </p>
        </div>
      )}
    </section>
  )
}
