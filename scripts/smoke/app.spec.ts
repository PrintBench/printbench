import { test, expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { sql } from 'drizzle-orm'
import { createDb } from '@pb/db'

// An ordinary tetrahedron, small enough to keep the smoke suite fast while
// still exercising parsing, geometry analysis and generated thumbnails.
const mesh = Buffer.from(`solid smoke
facet normal 0 0 -1
outer loop
vertex 0 0 0
vertex 0 10 0
vertex 10 0 0
endloop
endfacet
facet normal 0 -1 0
outer loop
vertex 0 0 0
vertex 10 0 0
vertex 0 0 10
endloop
endfacet
facet normal 1 1 1
outer loop
vertex 10 0 0
vertex 0 10 0
vertex 0 0 10
endloop
endfacet
facet normal -1 0 0
outer loop
vertex 0 10 0
vertex 0 0 0
vertex 0 0 10
endloop
endfacet
endsolid smoke
`)

test.describe.configure({ mode: 'serial' })

test('existing authentication checks against the production web server', async () => {
  const { db, pool } = createDb()
  try {
    const existing = await db.execute<{ users: number; libraries: number }>(sql`
      SELECT (SELECT count(*)::int FROM "user") AS users,
             (SELECT count(*)::int FROM libraries) AS libraries`)
    expect(existing.rows[0], 'Use an empty test database, never an existing instance').toEqual({
      users: 0,
      libraries: 0,
    })
    execFileSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'scripts/verify-phase1.mts'], {
      env: { ...process.env, VERIFY_BASE_URL: 'http://localhost:3000' },
      stdio: 'inherit',
      timeout: 60_000,
    })
  } finally {
    await pool.end()
  }
})

test('browser scan, upload, thumbnail delivery and revoked permissions', async ({
  page,
  request,
}) => {
  const { db, pool } = createDb()
  const run = randomUUID()
  const email = `smoke-${run}@example.test`
  const password = `throwaway-${randomUUID()}`
  const scanId = randomUUID()
  const uploadId = randomUUID()
  const root = process.env.SMOKE_ROOT!
  const scanPath = path.join(root, 'scan')
  const uploadPath = path.join(root, 'upload')

  async function indexed(libraryId: string) {
    const result = await db.execute<{
      public_id: string
      file_id: string
      thumb_state: string
    }>(sql`
      SELECT m.public_id, f.id AS file_id, f.thumb_state
      FROM models m JOIN model_files f ON f.model_id = m.id
      WHERE m.library_id = ${libraryId} LIMIT 1`)
    return result.rows[0]
  }

  try {
    await mkdir(path.join(scanPath, 'Smoke Model'), { recursive: true })
    await mkdir(uploadPath, { recursive: true })
    await writeFile(path.join(scanPath, 'Smoke Model', 'smoke.stl'), mesh)
    const signup = await request.post('/api/auth/sign-up/email', {
      headers: { origin: 'http://localhost:3000' },
      data: { name: 'Smoke Admin', email, password },
    })
    expect(signup.ok(), 'Throwaway signup').toBe(true)
    await db.execute(sql`UPDATE "user" SET role = 'admin' WHERE email = ${email}`)
    await db.execute(sql`
      INSERT INTO libraries (id, name, kind, backend, path, allow_writes, write_sidecar)
      VALUES (${scanId}, 'Smoke Scan Library', 'in_place', 'local', ${scanPath}, false, false),
             (${uploadId}, 'Smoke Upload Library', 'managed', 'local', ${uploadPath}, true, false)`)

    await page.goto('/login')
    await page.locator('input[name="email"]').fill(email)
    await page.locator('input[name="password"]').fill(password)
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(page).toHaveURL('http://localhost:3000/')

    await page.goto('/admin/libraries')
    const scanCard = page
      .locator('div')
      .filter({ has: page.getByRole('heading', { name: 'Smoke Scan Library', exact: true }) })
      .filter({ has: page.getByRole('button', { name: 'Deep scan', exact: true }) })
      .last()
    await scanCard.getByRole('button', { name: 'Deep scan', exact: true }).click()
    await expect
      .poll(
        async () => {
          const result = await db.execute<{ status: string }>(
            sql`SELECT status FROM scan_runs WHERE library_id = ${scanId} ORDER BY created_at DESC LIMIT 1`,
          )
          return result.rows[0]?.status
        },
        { timeout: 60_000, message: 'Web action must reach the running worker' },
      )
      .toBe('succeeded')
    await expect
      .poll(async () => (await indexed(scanId))?.thumb_state, { timeout: 60_000 })
      .toBe('ok')
    const scanned = (await indexed(scanId))!
    await page.goto(`/models/${scanned.public_id}`)
    await expect(page.getByRole('heading', { name: 'Smoke Model', exact: true })).toBeVisible()
    const thumbnail = await page.request.get(`/api/files/${scanned.file_id}/thumb`)
    expect(thumbnail.status()).toBe(200)
    expect(thumbnail.headers()['content-type']).toBe('image/webp')
    expect((await thumbnail.body()).length).toBeGreaterThan(100)
    expect((await fetch(`http://localhost:3000/api/files/${scanned.file_id}/thumb`)).status).toBe(
      403,
    )

    await page.goto('/upload')
    await page.getByLabel('Save to library').selectOption(uploadId)
    await page.locator('input[type="file"]').first().setInputFiles({
      name: 'uploaded-smoke.stl',
      mimeType: 'application/octet-stream',
      buffer: mesh,
    })
    await page.getByRole('button', { name: 'Upload 1', exact: true }).click()
    await expect
      .poll(async () => (await indexed(uploadId))?.thumb_state, {
        timeout: 60_000,
        message: 'Browser upload must be indexed and rendered by the worker',
      })
      .toBe('ok')
    expect(await readFile(path.join(uploadPath, 'uploaded-smoke.stl'))).toEqual(mesh)
    const uploaded = (await indexed(uploadId))!
    await page.goto(`/models/${uploaded.public_id}`)
    await expect(page.getByRole('heading', { level: 1 })).toContainText(/uploaded.smoke/i)

    // Keep the admin page open, revoke the role, then click its existing
    // control. This exercises server enforcement, not just hiding a button.
    await page.goto('/admin/libraries')
    await db.execute(sql`UPDATE "user" SET role = 'viewer' WHERE email = ${email}`)
    await page.getByRole('button', { name: 'Deep scan', exact: true }).first().click()
    await expect(page.getByText('Not permitted.', { exact: true })).toBeVisible()
    const runs = await db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM scan_runs WHERE library_id IN (${scanId}, ${uploadId})`,
    )
    expect(runs.rows[0]?.n).toBe(2)
    await page.goto('/upload')
    await expect(page.getByText("don't have access", { exact: false })).toBeVisible()
    await page.goto(`/models/${scanned.public_id}`)
    await expect(page.getByRole('heading', { name: 'Smoke Model', exact: true })).toBeVisible()
  } finally {
    try {
      await db.execute(sql`DELETE FROM libraries WHERE id IN (${scanId}, ${uploadId})`)
      await db.execute(sql`DELETE FROM "user" WHERE email = ${email}`)
    } finally {
      await pool.end()
    }
  }
})
