import { fileURLToPath } from 'node:url'
import type { NextConfig } from 'next'
import { loadRootEnv } from '@pm/core'

// Next only reads .env from apps/web; our .env lives at the repo root.
loadRootEnv()

const config: NextConfig = {
  // Emits a minimal standalone server bundle, so the runtime Docker stage does
  // not need node_modules. Keeps the image small.
  output: 'standalone',
  // The monorepo root, so standalone tracing picks up the workspace packages.
  // fileURLToPath, not URL.pathname: the latter yields "/D:/..." on Windows.
  outputFileTracingRoot: fileURLToPath(new URL('../../', import.meta.url)),
  // Workspace packages are shipped as TypeScript source, not built dist output.
  transpilePackages: ['@pm/db', '@pm/core', '@pm/auth'],
  typedRoutes: true,
}

export default config
