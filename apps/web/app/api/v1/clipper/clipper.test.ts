// @covers IMPORT-003
import { randomUUID } from 'node:crypto'
import { eq, inArray } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDb, schema } from '@pb/db'
import { saveMakerWorldCookie, saveThingiverseToken } from '@pb/core'
import { startModelSourceImport } from '@/app/(app)/upload/source-actions'
import {
  generateBrowserClipperToken,
  revokeBrowserClipperToken,
} from '@/app/(app)/settings/clipper-actions'
import { createClipperToken, listClipperTokens } from '@/lib/clipper-tokens'
import { GET as libraries } from './libraries/route'
import { POST as submit } from './imports/route'
import { GET as status } from './imports/[id]/route'

const { requireUser, send } = vi.hoisted(() => ({ requireUser: vi.fn(), send: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('@pb/auth', () => ({ requireUser }))
vi.mock('@pb/jobs', () => ({
  JOB: { makerWorldImport: 'model.import-makerworld' },
  getStartedQueue: async () => ({ send }),
}))
vi.mock('@/lib/audit', () => ({ audit: vi.fn() }))

describe('browser clipper API', { tags: ['integration'] }, () => {
  let owner: string
  let other: string
  let token: string
  let otherToken: string
  let libraryId: string
  let excluded: string[]

  function request(authorization?: string, input?: object | string) {
    const headers = new Headers()
    if (authorization) headers.set('Authorization', authorization)
    return new Request('http://localhost/api/v1/clipper', {
      headers,
      ...(input !== undefined && {
        method: 'POST',
        body: typeof input === 'string' ? input : JSON.stringify(input),
      }),
    })
  }

  function submitUrl(url: string, id = libraryId) {
    return submit(request('Bearer ' + token, { libraryId: id, url }))
  }

  beforeEach(async () => {
    vi.stubEnv('BETTER_AUTH_SECRET', 'browser-clipper-integration-test-secret')
    owner = randomUUID()
    other = randomUUID()
    libraryId = randomUUID()
    excluded = [randomUUID(), randomUUID(), randomUUID()]
    const db = getDb()
    await db.insert(schema.user).values(
      [owner, other].map((id) => ({
        id,
        name: 'Clipper member',
        email: id + '@example.test',
        role: 'member',
      })),
    )
    // The connection reuses the library's id: unique per test, and one less to track.
    await db
      .insert(schema.s3Connections)
      .values({ id: libraryId, name: 'Clipper ' + libraryId, bucket: 'test-bucket' })
    await db.insert(schema.libraries).values([
      {
        id: libraryId,
        name: 'Writable S3',
        kind: 'managed',
        backend: 's3',
        s3ConnectionId: libraryId,
      },
      { id: excluded[0]!, name: 'Read-only', path: '/read-only' },
      {
        id: excluded[1]!,
        name: 'No scanning',
        kind: 'managed',
        path: '/scan-off',
        scanEnabled: false,
      },
      { id: excluded[2]!, name: 'No path', kind: 'managed', path: '' },
    ])
    ;({ token } = await createClipperToken(db, owner, 'Firefox'))
    ;({ token: otherToken } = await createClipperToken(db, other, 'Edge'))
    requireUser.mockReset().mockResolvedValue({ id: owner, role: 'member' })
    send.mockReset().mockResolvedValue('queue-job')
  })

  afterEach(async () => {
    await getDb()
      .delete(schema.libraries)
      .where(inArray(schema.libraries.id, [libraryId, ...excluded]))
    await getDb().delete(schema.s3Connections).where(eq(schema.s3Connections.id, libraryId))
    await getDb()
      .delete(schema.user)
      .where(inArray(schema.user.id, [owner, other]))
    vi.unstubAllEnvs()
  })

  it('requires the bearer credential and exposes only import-ready libraries', async () => {
    expect((await libraries(request())).status).toBe(401)
    const response = await libraries(request('Bearer ' + token))
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toContain('no-store')
    const result = await response.json()
    expect(result.libraries).toContainEqual({ id: libraryId, name: 'Writable S3', backend: 's3' })
    for (const id of excluded)
      expect(result.libraries).not.toContainEqual(expect.objectContaining({ id }))

    for (const id of excluded) {
      expect((await submitUrl('https://www.printables.com/model/123', id)).status).toBe(400)
    }
    expect(send).not.toHaveBeenCalled()
  })

  it('stores only hashed tokens, scopes revocation, and checks current upload access and expiry', async () => {
    const generated = await generateBrowserClipperToken('  Chrome work  ')
    if ('error' in generated) throw new Error(generated.error)
    expect(generated.entry.label).toBe('Chrome work')
    expect(generated.token).toMatch(/^pb_clip_[A-Za-z0-9_-]{43}$/)
    const id = generated.entry.id
    const db = getDb()
    const [saved] = await db
      .select()
      .from(schema.clipperTokens)
      .where(eq(schema.clipperTokens.id, id))
    expect(saved!.tokenHash).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(await listClipperTokens(db, owner))).not.toContain(saved!.tokenHash)
    const credential = request('Bearer ' + generated.token)
    expect((await libraries(credential)).status).toBe(200)
    requireUser.mockResolvedValue({ id: other, role: 'member' })
    expect(await revokeBrowserClipperToken(id)).toHaveProperty('error')
    await db.update(schema.user).set({ role: 'viewer' }).where(eq(schema.user.id, owner))
    expect((await libraries(credential)).status).toBe(403)
    await db
      .update(schema.user)
      .set({ role: 'member', banned: true })
      .where(eq(schema.user.id, owner))
    expect((await libraries(credential)).status).toBe(403)
    await db.update(schema.user).set({ banned: false }).where(eq(schema.user.id, owner))
    await db
      .update(schema.clipperTokens)
      .set({ expiresAt: new Date(0) })
      .where(eq(schema.clipperTokens.id, id))
    expect((await libraries(credential)).status).toBe(401)

    const [active] = (await listClipperTokens(db, owner)).filter((entry) => entry.id !== id)
    requireUser.mockResolvedValue({ id: owner, role: 'viewer' })
    expect(await generateBrowserClipperToken('Another browser')).toHaveProperty('error')
    expect(await revokeBrowserClipperToken(active!.id)).toEqual({ ok: true })
    expect((await libraries(request('Bearer ' + token))).status).toBe(401)
    expect((await libraries(request('Bearer ' + otherToken))).status).toBe(200)
  })

  it('shares the Upload page import across all providers and scopes status to its owner', async () => {
    await saveMakerWorldCookie(getDb(), owner, 'example.makerworld.token')
    await saveThingiverseToken(getDb(), owner, 'example-thingiverse-token')
    const urls = [
      [
        'https://makerworld.com/en/models/123-example?ref=site#profileId-456',
        'https://makerworld.com/en/models/123#profileId-456',
      ],
      ['https://www.printables.com/model/123-example', 'https://www.printables.com/model/123'],
      ['https://www.thingiverse.com/thing:123', 'https://www.thingiverse.com/thing:123'],
    ]
    for (const [url, canonical] of urls) {
      const response = await submitUrl(url!)
      expect(response.status).toBe(202)
      const { id } = await response.json()
      expect(await startModelSourceImport({ libraryId, url: canonical! })).toEqual({ ok: true, id })
      const [record] = await getDb()
        .select()
        .from(schema.modelImports)
        .where(eq(schema.modelImports.id, id))
      expect(record).toMatchObject({ userId: owner, libraryId, sourceUrl: canonical })
      const params = { params: Promise.resolve({ id }) }
      expect(await (await status(request('Bearer ' + token), params)).json()).toEqual({
        state: 'queued',
        error: null,
        publicId: null,
      })
      expect((await status(request('Bearer ' + otherToken), params)).status).toBe(404)
      expect(send).toHaveBeenLastCalledWith(
        'model.import-makerworld',
        { importId: id },
        {
          singletonKey: 'import:' + id,
        },
      )
    }
  })

  it('returns safe validation and queue errors and retries the same record', async () => {
    const db = getDb()
    const url = 'https://www.printables.com/model/123'
    expect((await submit(request('Bearer ' + token, '{ broken'))).status).toBe(400)
    expect((await submit(request('Bearer ' + token, ' '.repeat(8193)))).status).toBe(400)
    expect((await submitUrl('https://example.test/model/123')).status).toBe(400)
    expect((await (await submitUrl('https://makerworld.com/en/models/123')).json()).error).toMatch(
      /MakerWorld/,
    )
    expect(send).not.toHaveBeenCalled()
    send.mockRejectedValueOnce(new Error('private-upstream-secret'))
    const first = await submitUrl(url)
    expect(first.status).toBe(503)
    expect(await first.json()).toEqual({ error: 'Could not queue the import. Please try again.' })
    const [failed] = await db
      .select()
      .from(schema.modelImports)
      .where(eq(schema.modelImports.userId, owner))
    expect(failed?.state).toBe('failed')
    const second = await submitUrl(url)
    expect(second.status).toBe(202)
    expect(await second.json()).toEqual({ id: failed!.id })
    const params = { params: Promise.resolve({ id: failed!.id }) }
    expect(await (await status(request('Bearer ' + token), params)).json()).toMatchObject({
      state: 'queued',
    })
  })
})
