import { fileURLToPath } from 'node:url'
import type { NextConfig } from 'next'
import { loadRootEnv } from '@pb/core'

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
  transpilePackages: ['@pb/db', '@pb/core', '@pb/auth', '@pb/mesh'],
  typedRoutes: true,

  /*
   * ZIP downloads are built by the worker process, not this one. In production
   * nginx routes /api/download/ there; in development there is no proxy, so
   * Next forwards it instead. Without this the button 404s in dev only, which
   * is a confusing way to find out.
   */
  async rewrites() {
    const worker = process.env.WORKER_URL ?? 'http://localhost:3001'
    return [
      { source: '/api/download/:path*', destination: `${worker}/api/download/:path*` },
      // tus owns everything under /api/upload, including the per-upload URLs it
      // hands back, so both the collection and its children are forwarded.
      { source: '/api/upload', destination: `${worker}/api/upload` },
      { source: '/api/upload/:path*', destination: `${worker}/api/upload/:path*` },
    ]
  },
}

export default config
