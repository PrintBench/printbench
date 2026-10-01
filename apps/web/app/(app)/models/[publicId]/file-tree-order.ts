export type OrderableFile = {
  filename: string
  displayName?: string
  extension: string
}

export type OrderableNode = {
  name: string
  folders: Map<string, OrderableNode>
  files: OrderableFile[]
}

function extensionPriority(extension: string): number {
  const normalized = extension.replace(/^\./, '').toLowerCase()

  if (normalized === '3mf') return 0
  if (normalized === 'stl') return 1
  return 2
}

export function compareFiles(a: OrderableFile, b: OrderableFile): number {
  const priority = extensionPriority(a.extension) - extensionPriority(b.extension)
  if (priority !== 0) return priority

  return (a.displayName ?? a.filename).localeCompare(b.displayName ?? b.filename, undefined, {
    numeric: true,
    sensitivity: 'base',
  })
}

export function contains3mf(node: OrderableNode): boolean {
  if (node.files.some((file) => extensionPriority(file.extension) === 0)) return true

  for (const folder of node.folders.values()) {
    if (contains3mf(folder)) return true
  }

  return false
}

export function compareFolders(a: OrderableNode, b: OrderableNode): number {
  const aHas3mf = contains3mf(a)
  const bHas3mf = contains3mf(b)

  if (aHas3mf !== bHas3mf) return aHas3mf ? -1 : 1

  return a.name.localeCompare(b.name, undefined, {
    numeric: true,
    sensitivity: 'base',
  })
}

export function orderTopLevel<T extends OrderableNode>(rootGroups: T[], folders: T[]): T[] {
  const sortedRootGroups = [...rootGroups].sort((a, b) => {
    const aFile = a.files[0]
    const bFile = b.files[0]

    if (aFile && bFile) return compareFiles(aFile, bFile)

    return a.name.localeCompare(b.name, undefined, {
      numeric: true,
      sensitivity: 'base',
    })
  })

  const sortedFolders = [...folders].sort(compareFolders)

  const root3mfGroups = sortedRootGroups.filter(contains3mf)
  const foldersWith3mf = sortedFolders.filter(contains3mf)
  const otherRootGroups = sortedRootGroups.filter((group) => !contains3mf(group))
  const otherFolders = sortedFolders.filter((folder) => !contains3mf(folder))

  return [...root3mfGroups, ...foldersWith3mf, ...otherRootGroups, ...otherFolders]
}
