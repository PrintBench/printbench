import { sql } from 'drizzle-orm'
import type { Database } from '@pb/db'

export interface ModelPreviewStatus {
  publicId: string
  state: 'pending' | 'ready' | 'unavailable'
  previewImageFileId: string | null
  thumbFileId: string | null
  thumbKey: string | null
}

export const PREVIEW_STATUS_BATCH_SIZE = 200

/** Read-only card status; creator artwork always takes precedence over a render. */
export async function modelPreviewStatuses(
  db: Database,
  publicIds: string[],
): Promise<ModelPreviewStatus[]> {
  const ids = [...new Set(publicIds)]
  if (ids.length === 0) return []
  if (ids.length > PREVIEW_STATUS_BATCH_SIZE) throw new Error('Too many preview IDs')

  const result = await db.execute<{
    public_id: string
    preview_image_file_id: string | null
    thumb_file_id: string | null
    thumb_key: string | null
    pending: boolean
  }>(sql`
    SELECT m.public_id,
           CASE WHEN selected.category = 'image' THEN selected.id END AS preview_image_file_id,
           thumb.id AS thumb_file_id, thumb.thumb_key,
           EXISTS (
             SELECT 1 FROM model_files pending
             WHERE pending.model_id = m.id AND pending.missing_at IS NULL
               AND pending.previewable AND pending.thumb_state = 'pending'
           ) AS pending
    FROM models m
    LEFT JOIN model_files selected
      ON selected.id = m.preview_file_id AND selected.missing_at IS NULL
    LEFT JOIN LATERAL (
      SELECT f.id, f.thumb_key FROM model_files f
      WHERE f.model_id = m.id AND f.missing_at IS NULL AND f.thumb_state = 'ok'
      ORDER BY (f.id = m.preview_file_id) DESC NULLS LAST, f.size DESC, f.id
      LIMIT 1
    ) thumb ON true
    WHERE m.missing_at IS NULL AND m.public_id IN (${sql.join(
      ids.map((id) => sql`${id}`),
      sql`, `,
    )})
  `)

  return result.rows.map((row) => ({
    publicId: row.public_id,
    state:
      row.preview_image_file_id || row.thumb_file_id
        ? 'ready'
        : row.pending
          ? 'pending'
          : 'unavailable',
    previewImageFileId: row.preview_image_file_id,
    thumbFileId: row.thumb_file_id,
    thumbKey: row.thumb_key,
  }))
}
