import { Download } from 'lucide-react'

/**
 * Downloads a single file.
 *
 * A plain link, not a fetch: the browser then owns the transfer, so progress,
 * pause and resume work, and a multi-gigabyte mesh never passes through
 * JavaScript memory. The endpoint sets Content-Disposition, so no `download`
 * attribute is needed — and relying on one would break for cross-origin
 * deployments.
 */
export function FileDownloadLink({ fileId, filename }: { fileId: string; filename: string }) {
  return (
    <a
      href={`/api/files/${fileId}/raw`}
      title={`Download ${filename}`}
      aria-label={`Download ${filename}`}
      className="shrink-0 rounded p-1 text-[var(--color-ink-faint)] transition-colors hover:bg-[var(--color-surface-2)] hover:text-[var(--color-ink)]"
    >
      <Download className="size-3.5" />
    </a>
  )
}
