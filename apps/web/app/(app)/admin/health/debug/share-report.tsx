'use client'

import { useState } from 'react'
import { Check, Copy, Download, ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

const ISSUES_URL = 'https://github.com/PrintBench/printbench/issues/new'

function save(filename: string, type: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

/**
 * Hands the report over in the shape a GitHub issue wants.
 *
 * The log excerpt is the only part that is free text from this instance, so
 * it is the one thing that can be left out, and the preview is right there to
 * read before anything is pasted in public.
 */
export function ShareReport({
  markdown,
  markdownWithoutLogs,
  json,
  logLines,
}: {
  markdown: string
  markdownWithoutLogs: string
  json: string
  logLines: number
}) {
  const [includeLogs, setIncludeLogs] = useState(true)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const text = includeLogs ? markdown : markdownWithoutLogs
  const stamp = new Date().toISOString().slice(0, 10)

  async function copy() {
    setError(null)
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2500)
    } catch {
      // Clipboard access needs HTTPS or localhost; plenty of LAN installs have neither.
      setError('Could not reach the clipboard. Download the report, or copy it from the preview.')
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Share with a bug report</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-[var(--color-ink-muted)]">
          The report contains versions, settings, counts and states. It leaves out hostnames, URLs,
          file paths, email addresses and the names of your users, libraries and models, and it
          never includes passwords or keys.
        </p>

        <label className="flex items-start gap-2.5 text-sm">
          <input
            type="checkbox"
            checked={includeLogs}
            onChange={(event) => setIncludeLogs(event.target.checked)}
            className="mt-0.5 size-4 accent-[var(--color-accent)]"
          />
          <span>
            Include the last {logLines} warning{logLines === 1 ? '' : 's'} and errors from the log
            <span className="block text-xs text-[var(--color-ink-muted)]">
              Usually the most useful part. Log lines are real text from your instance and can
              mention file and library names, so read the preview before posting it publicly.
            </span>
          </span>
        </label>

        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={copy}>
            {copied ? <Check /> : <Copy />}
            {copied ? 'Copied' : 'Copy for GitHub'}
          </Button>
          <Button
            variant="secondary"
            onClick={() => save(`printbench-debug-${stamp}.md`, 'text/markdown', text)}
          >
            <Download />
            Markdown
          </Button>
          <Button
            variant="secondary"
            onClick={() => save(`printbench-debug-${stamp}.json`, 'application/json', json)}
          >
            <Download />
            JSON
          </Button>
          <Button asChild variant="ghost">
            <a href={ISSUES_URL} target="_blank" rel="noreferrer">
              <ExternalLink />
              Open an issue
            </a>
          </Button>
        </div>

        {error && <p className="text-sm text-[var(--color-danger)]">{error}</p>}

        <details>
          <summary className="cursor-pointer text-sm font-medium">
            Preview what will be shared
          </summary>
          <pre className="mt-3 max-h-96 overflow-auto rounded-[var(--radius-control)] bg-[var(--color-surface-2)] p-3 font-mono text-xs leading-5">
            {text}
          </pre>
        </details>
      </CardContent>
    </Card>
  )
}
