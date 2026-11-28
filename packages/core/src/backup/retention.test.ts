// @covers BACKUP-002
import { describe, expect, it } from 'vitest'
import {
  backupObjectName,
  backupsToPrune,
  isBackupObjectName,
  parseBackupPath,
  s3PrefixesOverlap,
} from './retention'

/**
 * Which backups retention deletes, and which prefixes count as shared.
 * Pruning is the one place scheduled backups delete anything, so its limits
 * are spelled out case by case.
 */

const at = (day: number) => backupObjectName(new Date(Date.UTC(2026, 10, day, 2, 30)))

describe('backup retention', () => {
  it('names backups so they sort by time', () => {
    expect(at(3)).toBe('printbench-2026-11-03T02-30-00Z.encrypted.pbbackup')
    expect([at(10), at(2), at(28)].sort()).toEqual([at(2), at(10), at(28)])
    expect(isBackupObjectName(at(3))).toBe(true)
  })

  it.each([
    ['keeps the newest N', [at(1), at(2), at(3), at(4)], 2, at(4), [at(2), at(1)]],
    ['deletes nothing when there are fewer than N', [at(1), at(2)], 5, at(2), []],
    ['deletes nothing if the new backup is not listed yet', [at(1), at(2), at(3)], 1, at(4), []],
    ['never keeps fewer than one', [at(1), at(2)], 0, at(2), [at(1)]],
    [
      'never touches names it did not write',
      [at(1), at(2), 'notes.txt', 'printbench-manual.pbbackup', `old/${at(0)}`],
      1,
      at(2),
      [at(1)],
    ],
    ['keeps the new backup even if its clock is behind', [at(5), at(6), at(3)], 1, at(3), [at(5)]],
  ])('%s', (_label, names, keep, written, expected) => {
    const pruned = backupsToPrune(names, keep, written)
    expect(pruned).not.toContain(written)
    expect(pruned.sort()).toEqual([...expected].sort())
  })

  const instance = '0f1e2d3c-4b5a-4968-8776-655443322110'

  it.each([
    ['a backup in an instance folder', `${instance}/${at(3)}`, true],
    ['a backup at the top of the prefix', at(3), false],
    ['a folder that is not an instance id', `models/${at(3)}`, false],
    ['a file that is not a backup', `${instance}/notes.txt`, false],
    ['a deeper path', `${instance}/${instance}/${at(3)}`, false],
    ['a path climbing out', `../${instance}/${at(3)}`, false],
    ['the folder alone', `${instance}/`, false],
  ])('a restore may fetch %s: %s', (_label, path, allowed) => {
    expect(parseBackupPath(path) !== null).toBe(allowed)
  })

  it.each([
    ['backups', 'backups', true],
    ['backups', 'backups/', true],
    ['models', 'models/backups', true],
    ['models/backups', 'models', true],
    ['backups', 'backups-old', false],
    ['backups', 'models', false],
    [null, 'backups', true],
    ['backups', '', true],
  ])('%s and %s overlap: %s', (a, b, expected) => {
    expect(s3PrefixesOverlap(a, b)).toBe(expected)
  })
})
