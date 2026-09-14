'use client'

import { useState } from 'react'
import { ChevronDown, ChevronRight, Folder } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { formatBytes } from '@/components/model/model-card'
import { FileDownloadLink } from './file-download-link'
import { OpenInSlicer } from './open-in-slicer'
import { SendToPrinter } from './send-to-printer'

export type TreeFile = {
  id: string
  filename: string
  displayName?: string
  extension: string
  size: string
  presupported: boolean
  missing_at: string | null
  triangle_count: number | null
  canOpenInSlicer: boolean
  canSendToPrinter: boolean
}

type TreeNode = {
  name: string
  folders: Map<string, TreeNode>
  files: TreeFile[]
}

const NUMBER = new Intl.NumberFormat('en-GB')

function makeNode(name: string): TreeNode {
  return {
    name,
    folders: new Map(),
    files: [],
  }
}

function buildTree(files: TreeFile[]): TreeNode {
  const root = makeNode('')

  for (const file of files) {
    const parts = file.filename.split('/').filter(Boolean)
    const fileName = parts.pop() ?? file.filename

    let current = root

    for (const part of parts) {
      let child = current.folders.get(part)

      if (!child) {
        child = makeNode(part)
        current.folders.set(part, child)
      }

      current = child
    }

    current.files.push({
      ...file,
      displayName: fileName,
    })
  }

  return root
}

function countFiles(node: TreeNode): number {
  let count = node.files.length

  for (const child of node.folders.values()) {
    count += countFiles(child)
  }

  return count
}

function FileRow({ file, depth }: { file: TreeFile; depth: number }) {
  return (
    <li
      className={
        file.missing_at
          ? 'flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-[var(--color-border)] px-4 py-2.5 opacity-50'
          : 'flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-[var(--color-border)] px-4 py-2.5'
      }
      style={{ paddingLeft: `${16 + depth * 20}px` }}
    >
      <span className="w-10 shrink-0 rounded bg-[var(--color-surface-2)] px-1.5 py-0.5 text-center text-[10px] font-medium uppercase text-[var(--color-ink-faint)]">
        {file.extension || '—'}
      </span>

      <span
        className="min-w-0 flex-1 basis-40 truncate text-sm"
        title={file.filename}
      >
        {file.displayName ?? file.filename}
      </span>

      {file.presupported && <Badge tone="accent">supported</Badge>}
      {file.missing_at && <Badge tone="danger">missing</Badge>}

      {file.triangle_count != null && (
        <span className="hidden shrink-0 text-xs tabular-nums text-[var(--color-ink-faint)] sm:inline">
          {NUMBER.format(file.triangle_count)} tris
        </span>
      )}

      <span className="shrink-0 text-xs tabular-nums text-[var(--color-ink-muted)]">
        {formatBytes(Number(file.size))}
      </span>

      {!file.missing_at && (
        <>
          {file.canOpenInSlicer && (
            <OpenInSlicer fileId={file.id} filename={file.filename} />
          )}

          {file.canSendToPrinter && (
            <SendToPrinter fileId={file.id} filename={file.filename} />
          )}

          <FileDownloadLink fileId={file.id} filename={file.filename} />
        </>
      )}
    </li>
  )
}

function FolderNode({
  node,
  depth,
}: {
  node: TreeNode
  depth: number
}) {
  /*
   * Top-level folders such as "3MF File - TitanPals Astro" and
   * "STL Files - TitanPals Astro" start expanded.
   *
   * Their children (ARM, BODY, HELMET, etc.) start collapsed.
   */
  const [expanded, setExpanded] = useState(depth === 0)
  const total = countFiles(node)

  const folders = [...node.folders.values()].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, {
      numeric: true,
      sensitivity: 'base',
    }),
  )

  const files = [...node.files].sort((a, b) =>
    (a.displayName ?? a.filename).localeCompare(b.displayName ?? b.filename, undefined, {
      numeric: true,
      sensitivity: 'base',
    }),
  )

  return (
    <li>
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center gap-2 border-t border-[var(--color-border)] px-4 py-2.5 text-left hover:bg-[var(--color-surface-2)]"
        style={{ paddingLeft: `${16 + depth * 20}px` }}
      >
        {expanded ? (
          <ChevronDown className="size-4 shrink-0 text-[var(--color-ink-muted)]" />
        ) : (
          <ChevronRight className="size-4 shrink-0 text-[var(--color-ink-muted)]" />
        )}

        <Folder className="size-4 shrink-0 text-[var(--color-ink-muted)]" />

        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {node.name}
        </span>

        <span className="shrink-0 text-xs tabular-nums text-[var(--color-ink-faint)]">
          {total}
        </span>
      </button>

      {expanded && (
        <ul>
          {folders.map((folder) => (
            <FolderNode
              key={`${depth}-${folder.name}`}
              node={folder}
              depth={depth + 1}
            />
          ))}

          {files.map((file) => (
            <FileRow
              key={file.id}
              file={file}
              depth={depth + 1}
            />
          ))}
        </ul>
      )}
    </li>
  )
}

export function FileTree({ files }: { files: TreeFile[] }) {
  const tree = buildTree(files)

  const folders = [...tree.folders.values()].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, {
      numeric: true,
      sensitivity: 'base',
    }),
  )

  const rootFiles = [...tree.files].sort((a, b) =>
    (a.displayName ?? a.filename).localeCompare(b.displayName ?? b.filename, undefined, {
      numeric: true,
      sensitivity: 'base',
    }),
  )

  return (
    <ul>
      {folders.map((folder) => (
        <FolderNode
          key={folder.name}
          node={folder}
          depth={0}
        />
      ))}

      {rootFiles.map((file) => (
        <FileRow
          key={file.id}
          file={file}
          depth={0}
        />
      ))}
    </ul>
  )
}
