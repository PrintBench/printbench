import type { SearchHit } from '@pb/core'
import { ModelCard, formatDimensions } from './model-card'

/**
 * The standard grid of model cards.
 *
 * Extracted because creators, tags, collections and search all show the same
 * thing, and four copies of the card call is four places to forget a prop.
 */
export function ModelGrid({ models }: { models: SearchHit[] }) {
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-4">
      {models.map((model) => (
        <ModelCard
          key={model.id}
          publicId={model.publicId}
          name={model.name}
          path={model.path}
          fileCount={model.fileCount}
          totalSize={model.totalSize}
          libraryName={model.libraryName}
          previewExtension={model.previewExtension}
          thumbFileId={model.thumbFileId}
          dimensions={formatDimensions(model.bboxX ?? 0, model.bboxY ?? 0, model.bboxZ ?? 0)}
        />
      ))}
    </div>
  )
}
