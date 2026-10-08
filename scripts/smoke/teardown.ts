import { rm } from 'node:fs/promises'
import path from 'node:path'

export default async function teardown() {
  const root = process.env.SMOKE_ROOT
  if (root && path.isAbsolute(root) && path.basename(root).startsWith('pb-smoke-')) {
    await rm(root, { recursive: true, force: true })
  }
}
