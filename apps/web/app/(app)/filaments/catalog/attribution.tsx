import type { CatalogStatus } from '@pb/core'

/**
 * Credit for the data. The Open Filament Database is MIT licensed; the licence
 * text ships with the data (packages/filament-catalog/data/LICENSE-OFD), and
 * this line is the visible acknowledgement.
 */
export function CatalogAttribution({ status }: { status: CatalogStatus }) {
  return (
    <p className="border-t border-[var(--color-border)] pt-4 text-xs text-[var(--color-ink-faint)]">
      Filament data from the{' '}
      <a
        href="https://github.com/OpenFilamentCollective/open-filament-database"
        target="_blank"
        rel="noopener noreferrer"
        className="underline hover:text-[var(--color-ink)]"
      >
        Open Filament Database
      </a>{' '}
      (MIT licence), dataset {status.datasetVersion}, bundled with this version of PrintBench.
      Community-maintained: check the manufacturer’s data sheet before relying on a value.
    </p>
  )
}
