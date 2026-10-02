import { sql, type SQL } from 'drizzle-orm'

/**
 * A model's format is independent of its artwork. Prefer its selected 3D file,
 * then another live 3D file; slicer files are a fallback for print-only models.
 * Image-only packages have no model format badge.
 *
 * The caller supplies SQL expressions from its model row, never user strings.
 */
export function modelFormatSql(modelId: SQL, previewFileId: SQL): SQL {
  return sql`(
    SELECT format_file.extension FROM model_files format_file
    WHERE format_file.model_id = ${modelId} AND format_file.missing_at IS NULL
      AND format_file.category IN ('model', 'slicer')
    ORDER BY (format_file.category = 'model') DESC,
             (format_file.id = ${previewFileId}) DESC NULLS LAST,
             format_file.size DESC, format_file.filename COLLATE "C", format_file.id
    LIMIT 1
  )`
}
