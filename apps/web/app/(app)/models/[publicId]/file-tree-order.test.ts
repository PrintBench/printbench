import { describe, expect, it } from 'vitest'
import {
  compareFiles,
  compareFolders,
  contains3mf,
  orderTopLevel,
  type OrderableNode,
} from './file-tree-order'

function node(
  name: string,
  files: Array<{ filename: string; extension: string }> = [],
  folders: OrderableNode[] = [],
): OrderableNode {
  return {
    name,
    files,
    folders: new Map(folders.map((folder) => [folder.name, folder])),
  }
}

describe('file tree ordering', () => {
  it('orders 3MF before STL and other file types', () => {
    const files = [
      { filename: 'notes.txt', extension: 'txt' },
      { filename: 'part.stl', extension: 'stl' },
      { filename: 'project.3mf', extension: '3mf' },
    ]

    expect(files.sort(compareFiles).map((file) => file.filename)).toEqual([
      'project.3mf',
      'part.stl',
      'notes.txt',
    ])
  })

  it('orders files alphabetically within the same format', () => {
    const files = [
      { filename: 'Part 10.stl', extension: 'stl' },
      { filename: 'Part 2.stl', extension: 'stl' },
      { filename: 'Part 1.stl', extension: 'stl' },
    ]

    expect(files.sort(compareFiles).map((file) => file.filename)).toEqual([
      'Part 1.stl',
      'Part 2.stl',
      'Part 10.stl',
    ])
  })

  it('detects a 3MF nested inside a subfolder', () => {
    const folder = node(
      'Bambu',
      [],
      [node('Projects', [{ filename: 'Complete Model.3mf', extension: '3mf' }])],
    )

    expect(contains3mf(folder)).toBe(true)
  })

  it('prioritizes folders containing a 3MF', () => {
    const stlFolder = node('AAA STL Files', [{ filename: 'Body.stl', extension: 'stl' }])
    const projectFolder = node('ZZZ Bambu Project', [
      { filename: 'Complete Model.3mf', extension: '3mf' },
    ])

    expect([stlFolder, projectFolder].sort(compareFolders).map((folder) => folder.name)).toEqual([
      'ZZZ Bambu Project',
      'AAA STL Files',
    ])
  })

  it('orders folders alphabetically when their 3MF priority is equal', () => {
    const folders = [
      node('Part 10', [{ filename: 'part.stl', extension: 'stl' }]),
      node('Part 2', [{ filename: 'part.stl', extension: 'stl' }]),
      node('Part 1', [{ filename: 'part.stl', extension: 'stl' }]),
    ]

    expect(folders.sort(compareFolders).map((folder) => folder.name)).toEqual([
      'Part 1',
      'Part 2',
      'Part 10',
    ])
  })

  it('orders root 3MF, nested 3MF folders, root STL, then ordinary folders', () => {
    const root3mf = node('3MF', [{ filename: 'Complete Project.3mf', extension: '3mf' }])
    const rootStl = node('STL', [{ filename: 'Body.stl', extension: 'stl' }])
    const projectFolder = node('Bambu', [
      { filename: 'Bambu/Ready to Print.3mf', extension: '3mf' },
    ])
    const partsFolder = node('Parts', [{ filename: 'Parts/Arm.stl', extension: 'stl' }])

    expect(
      orderTopLevel([rootStl, root3mf], [partsFolder, projectFolder]).map((item) => item.name),
    ).toEqual(['3MF', 'Bambu', 'STL', 'Parts'])
  })
})
