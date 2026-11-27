// @covers S3-001 S3-002
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq, inArray, sql } from 'drizzle-orm'
import { createDb, schema } from '@pb/db'
import { decryptSecret, encryptSecret } from '../security/secret-box'
import type { LibraryLocation } from '../storage/types'
import {
  createS3Connection,
  deleteS3Connection,
  listS3Connections,
  normalizeS3Prefix,
  resolveLibraryLocation,
  updateS3Connection,
  type LocationCheck,
} from './s3-connection-service'
import { createS3Library, updateLibrarySettings } from './library-settings-service'

/**
 * Shared S3 connections, and editing a library after it exists.
 *
 * No bucket is involved: the reachability check is injected, and records
 * what it was asked to check, so these tests can say both "nothing is saved
 * when the bucket refuses" and "every library on the connection was checked
 * at its own prefix" — the two properties that make rotating a shared key
 * safe.
 */

const SECRET = 's3-connection-service-test-secret'
const NAME = 'S3 service test'

describe('S3 connections', { tags: ['integration'] }, () => {
  let pool: ReturnType<typeof createDb>['pool']
  let db: ReturnType<typeof createDb>['db']
  let checked: LibraryLocation[]
  let refuse: ((location: LibraryLocation) => string | null) | null

  const check: LocationCheck = async (location) => {
    checked.push(location)
    const reason = refuse?.(location) ?? null
    return reason ? { ok: false, reason } : { ok: true }
  }

  beforeAll(() => {
    vi.stubEnv('BETTER_AUTH_SECRET', SECRET)
    ;({ pool, db } = createDb())
  })

  afterAll(async () => {
    await cleanup()
    await pool.end()
    vi.unstubAllEnvs()
  })

  beforeEach(async () => {
    await cleanup()
    checked = []
    refuse = null
  })

  async function cleanup() {
    const ours = await db
      .select({ id: schema.s3Connections.id })
      .from(schema.s3Connections)
      .where(sql`${schema.s3Connections.name} LIKE ${NAME + '%'}`)
    const ids = ours.map((row) => row.id)
    if (ids.length === 0) return
    await db.delete(schema.libraries).where(inArray(schema.libraries.s3ConnectionId, ids))
    await db.delete(schema.s3Connections).where(inArray(schema.s3Connections.id, ids))
  }

  async function connection(suffix: string, input: Record<string, string> = {}) {
    const created = await createS3Connection(
      db,
      {
        name: `${NAME} ${suffix}`,
        bucket: 'prints',
        accessKeyId: 'AKIA-ONE',
        secretAccessKey: 'secret-one',
        ...input,
      },
      { check },
    )
    if (!created.ok) throw new Error(created.error)
    return created.data.id
  }

  async function library(connectionId: string, prefix: string | null, name = 'Library') {
    const created = await createS3Library(
      db,
      {
        name: `${NAME} ${name}`,
        kind: 'in_place',
        connectionId,
        prefix,
        groupingMode: 'deepest',
        writeSidecar: true,
      },
      { check },
    )
    if (!created.ok) throw new Error(created.error)
    return created.data.id
  }

  async function storedSecret(id: string) {
    const [row] = await db
      .select({ secret: schema.s3Connections.secretAccessKey })
      .from(schema.s3Connections)
      .where(eq(schema.s3Connections.id, id))
    return row!.secret
  }

  it('stores the secret encrypted, and never lists it', async () => {
    const id = await connection('a')

    const stored = await storedSecret(id)
    expect(stored).not.toBe('secret-one')
    expect(decryptSecret(stored)).toBe('secret-one')

    const listed = (await listS3Connections(db)).find((entry) => entry.id === id)!
    expect(listed).toMatchObject({
      hasSecret: true,
      secretUnreadable: false,
      bucket: 'prints',
      provider: 'AWS',
    })
    expect(JSON.stringify(listed)).not.toContain(stored!)
    expect(JSON.stringify(listed)).not.toContain('secret-one')
  })

  it('refuses half a key pair, a duplicate name and an unreachable bucket', async () => {
    await connection('a')

    const half = await createS3Connection(
      db,
      { name: `${NAME} b`, bucket: 'prints', accessKeyId: 'AKIA' },
      { check },
    )
    expect(half).toMatchObject({ ok: false, error: expect.stringMatching(/both/) })

    const duplicate = await createS3Connection(
      db,
      { name: `${NAME} A`, bucket: 'prints' },
      { check },
    )
    expect(duplicate).toMatchObject({ ok: false, error: expect.stringMatching(/name/) })

    refuse = () => 'Access denied'
    const unreachable = await createS3Connection(
      db,
      { name: `${NAME} c`, bucket: 'prints' },
      { check },
    )
    expect(unreachable).toEqual({ ok: false, error: 'Access denied' })
    expect((await listS3Connections(db)).some((entry) => entry.name === `${NAME} c`)).toBe(false)
  })

  it('lets several libraries share one bucket at different prefixes, but not the same one', async () => {
    const id = await connection('a')
    await library(id, 'models', 'Models')
    await library(id, 'archive/', 'Archive')

    // "/models/" is the same prefix as "models", and would index every model twice.
    const clash = await createS3Library(
      db,
      {
        name: `${NAME} Again`,
        kind: 'in_place',
        connectionId: id,
        prefix: '/models/',
        groupingMode: 'deepest',
        writeSidecar: true,
      },
      { check },
    )
    expect(clash).toMatchObject({ ok: false, error: expect.stringMatching(/already indexes/) })

    // Through a second connection to the same bucket is still the same files.
    const other = await connection('b', { accessKeyId: 'AKIA-TWO', secretAccessKey: 'two' })
    const viaOther = await createS3Library(
      db,
      {
        name: `${NAME} Via other`,
        kind: 'in_place',
        connectionId: other,
        prefix: 'models',
        groupingMode: 'deepest',
        writeSidecar: true,
      },
      { check },
    )
    expect(viaOther.ok).toBe(false)

    const listed = (await listS3Connections(db)).find((entry) => entry.id === id)!
    expect(listed.libraries.map((entry) => entry.prefix).sort()).toEqual(['archive', 'models'])
  })

  it('resolves a library to its connection’s bucket and key, with its own prefix', async () => {
    const id = await connection('a')
    const libraryId = await library(id, 'models')

    const [row] = await db.select().from(schema.libraries).where(eq(schema.libraries.id, libraryId))
    const location = await resolveLibraryLocation(db, row!)

    expect(location).toMatchObject({
      backend: 's3',
      s3Bucket: 'prints',
      s3Prefix: 'models',
      s3AccessKeyId: 'AKIA-ONE',
      s3SecretAccessKey: 'secret-one',
    })
  })

  it('rotates a key for every library at once, after checking each at its own prefix', async () => {
    const id = await connection('a')
    const first = await library(id, 'models', 'Models')
    const second = await library(id, 'archive', 'Archive')
    checked = []

    const rotated = await updateS3Connection(
      db,
      id,
      {
        name: `${NAME} a`,
        bucket: 'prints',
        accessKeyId: 'AKIA-NEW',
        secretAccessKey: 'secret-new',
      },
      { check },
    )
    expect(rotated).toMatchObject({
      ok: true,
      data: { changed: ['accessKeyId', 'secretAccessKey'], libraryCount: 2 },
    })
    expect(checked.map((location) => location.s3Prefix).sort()).toEqual(['archive', 'models'])
    expect(checked.every((location) => location.s3SecretAccessKey === 'secret-new')).toBe(true)

    for (const libraryId of [first, second]) {
      const [row] = await db
        .select()
        .from(schema.libraries)
        .where(eq(schema.libraries.id, libraryId))
      const location = await resolveLibraryLocation(db, row!)
      expect(location.s3AccessKeyId).toBe('AKIA-NEW')
      expect(location.s3SecretAccessKey).toBe('secret-new')
    }
  })

  it('saves nothing when one library on the connection cannot be read with the new key', async () => {
    const id = await connection('a')
    await library(id, 'models', 'Models')
    await library(id, 'archive', 'Archive')
    const before = await storedSecret(id)

    refuse = (location) => (location.s3Prefix === 'archive' ? 'Access denied' : null)
    const result = await updateS3Connection(
      db,
      id,
      { name: `${NAME} a`, bucket: 'prints', accessKeyId: 'AKIA-NEW', secretAccessKey: 'x' },
      { check },
    )

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringMatching(/Archive.*Access denied/),
    })
    expect(await storedSecret(id)).toBe(before)
  })

  it('keeps the stored secret when it is left blank, but not for a different key', async () => {
    const id = await connection('a')
    const before = await storedSecret(id)

    const renamed = await updateS3Connection(
      db,
      id,
      { name: `${NAME} renamed`, bucket: 'prints', accessKeyId: 'AKIA-ONE', secretAccessKey: '' },
      { check },
    )
    expect(renamed).toMatchObject({ ok: true, data: { changed: ['name'] } })
    expect(await storedSecret(id)).toBe(before)
    expect(checked.at(-1)?.s3SecretAccessKey).toBe('secret-one')

    const newKey = await updateS3Connection(
      db,
      id,
      { name: `${NAME} renamed`, bucket: 'prints', accessKeyId: 'AKIA-OTHER' },
      { check },
    )
    expect(newKey).toMatchObject({ ok: false, error: expect.stringMatching(/secret/) })

    const serverCredentials = await updateS3Connection(
      db,
      id,
      { name: `${NAME} renamed`, bucket: 'prints', accessKeyId: '' },
      { check },
    )
    expect(serverCredentials.ok).toBe(true)
    expect(await storedSecret(id)).toBeNull()
  })

  it('asks for the secret again when the stored one no longer decrypts', async () => {
    const id = await connection('a')
    await db
      .update(schema.s3Connections)
      .set({ secretAccessKey: encryptSecret('secret-one', 'a-rotated-instance-secret') })
      .where(eq(schema.s3Connections.id, id))

    expect((await listS3Connections(db)).find((entry) => entry.id === id)?.secretUnreadable).toBe(
      true,
    )
    const result = await updateS3Connection(
      db,
      id,
      { name: `${NAME} a`, bucket: 'prints', accessKeyId: 'AKIA-ONE' },
      { check },
    )
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/Enter it again/) })
  })

  it('fixes the bucket while libraries use the connection', async () => {
    const id = await connection('a')
    await library(id, null)

    const moved = await updateS3Connection(
      db,
      id,
      { name: `${NAME} a`, bucket: 'elsewhere', accessKeyId: 'AKIA-ONE' },
      { check },
    )
    expect(moved).toMatchObject({ ok: false, error: expect.stringMatching(/bucket cannot change/) })

    const unused = await connection('b')
    const free = await updateS3Connection(
      db,
      unused,
      { name: `${NAME} b`, bucket: 'elsewhere', accessKeyId: 'AKIA-ONE' },
      { check },
    )
    expect(free.ok).toBe(true)
  })

  it('refuses to remove a connection a library still uses', async () => {
    const id = await connection('a')
    const libraryId = await library(id, null, 'Kept')

    const refused = await deleteS3Connection(db, id)
    expect(refused).toMatchObject({ ok: false, error: expect.stringMatching(/Kept/) })

    await db.delete(schema.libraries).where(eq(schema.libraries.id, libraryId))
    expect(await deleteS3Connection(db, id)).toMatchObject({ ok: true })
  })

  describe('editing a library', () => {
    it('renames it and changes the sidecar setting', async () => {
      const id = await connection('a')
      const libraryId = await library(id, 'models', 'Before')

      const result = await updateLibrarySettings(
        db,
        libraryId,
        { name: `${NAME} After`, writeSidecar: false },
        { check },
      )
      expect(result).toMatchObject({
        ok: true,
        data: { previousName: `${NAME} Before`, changed: ['name', 'writeSidecar'] },
      })

      const [row] = await db
        .select()
        .from(schema.libraries)
        .where(eq(schema.libraries.id, libraryId))
      expect(row).toMatchObject({ name: `${NAME} After`, writeSidecar: false, s3Prefix: 'models' })
    })

    it('moves it to another connection for the same bucket, checked at its prefix', async () => {
      const first = await connection('a')
      const second = await connection('b', { accessKeyId: 'AKIA-TWO', secretAccessKey: 'two' })
      const libraryId = await library(first, 'models')
      checked = []

      const result = await updateLibrarySettings(
        db,
        libraryId,
        { name: `${NAME} Library`, writeSidecar: true, s3ConnectionId: second },
        { check },
      )
      expect(result).toMatchObject({ ok: true, data: { changed: ['s3Connection'] } })
      expect(checked).toHaveLength(1)
      expect(checked[0]).toMatchObject({ s3Prefix: 'models', s3AccessKeyId: 'AKIA-TWO' })

      // The first connection is now free to remove: access withdrawn in one place.
      expect(await deleteS3Connection(db, first)).toMatchObject({ ok: true })
    })

    it('refuses a connection to a different bucket', async () => {
      const first = await connection('a')
      const elsewhere = await connection('b', { bucket: 'other-bucket' })
      const libraryId = await library(first, 'models')

      const result = await updateLibrarySettings(
        db,
        libraryId,
        { name: `${NAME} Library`, writeSidecar: true, s3ConnectionId: elsewhere },
        { check },
      )
      expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/same bucket/) })
    })

    it('keeps the old connection when the new one cannot read the library', async () => {
      const first = await connection('a')
      const second = await connection('b')
      const libraryId = await library(first, 'models')

      refuse = () => 'Access denied'
      const result = await updateLibrarySettings(
        db,
        libraryId,
        { name: `${NAME} Library`, writeSidecar: true, s3ConnectionId: second },
        { check },
      )
      expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/Access denied/) })

      const [row] = await db
        .select({ connection: schema.libraries.s3ConnectionId })
        .from(schema.libraries)
        .where(eq(schema.libraries.id, libraryId))
      expect(row!.connection).toBe(first)
    })
  })
})

describe('normalizeS3Prefix', () => {
  it('treats slashes and blanks the way the adapter does', () => {
    expect(normalizeS3Prefix('/models/')).toBe('models')
    expect(normalizeS3Prefix(' models/sub// ')).toBe('models/sub')
    expect(normalizeS3Prefix('')).toBeNull()
    expect(normalizeS3Prefix('/')).toBeNull()
    expect(normalizeS3Prefix(null)).toBeNull()
  })
})
