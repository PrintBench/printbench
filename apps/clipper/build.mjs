import { Buffer } from 'node:buffer'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { build } from 'esbuild'
import { zipSync } from 'fflate'

const rootVersion = JSON.parse(await readFile('../../package.json', 'utf8')).version
const version = rootVersion.split('-')[0]
const loopback = ['localhost', '127.0.0.1', '[::1]']

const shared = {
  manifest_version: 3,
  name: 'PrintBench Clipper',
  version,
  description: 'Send printable models to your own PrintBench library.',
  permissions: ['activeTab', 'storage'],
  optional_host_permissions: ['https://*/*', ...loopback.map((host) => 'http://' + host + '/*')],
  icons: { 128: 'icon.png' },
  action: {
    default_popup: 'popup.html',
    default_title: 'Send to PrintBench',
    default_icon: { 128: 'icon.png' },
  },
  options_ui: { page: 'options.html', open_in_tab: true },
}

const { outputFiles } = await build({
  entryPoints: ['src/popup.ts', 'src/options.ts', 'src/background.ts'],
  bundle: true,
  format: 'iife',
  target: ['chrome121', 'firefox140'],
  outdir: 'dist',
  write: false,
})

const assets = Object.fromEntries(
  await Promise.all(
    ['popup.html', 'options.html', 'styles.css', 'icon.png'].map(async (name) => [
      name,
      await readFile(join('public', name)),
    ]),
  ),
)
for (const file of outputFiles) {
  const name = file.path.split(/[/\\]/).at(-1)
  assets[name] = file.contents
}

for (const [browser, manifest] of Object.entries({
  chromium: {
    ...shared,
    minimum_chrome_version: '121',
    background: { service_worker: 'background.js' },
  },
  firefox: {
    ...shared,
    background: { scripts: ['background.js'] },
    browser_specific_settings: {
      gecko: {
        id: 'clipper@printbench.app',
        strict_min_version: '140.0',
        data_collection_permissions: { required: ['authenticationInfo', 'browsingActivity'] },
      },
    },
  },
})) {
  const destination = join('dist', browser)
  const files = {
    ...assets,
    'manifest.json': Buffer.from(JSON.stringify(manifest, null, 2) + '\n'),
  }
  await mkdir(destination, { recursive: true })
  await Promise.all(
    Object.entries(files).map(([name, data]) => writeFile(join(destination, name), data)),
  )
  const suffix = browser === 'firefox' ? 'firefox-unsigned' : 'chrome-edge'
  const zip = zipSync(files, { mtime: new Date(2020, 0, 1) })
  await writeFile(join('dist', 'printbench-clipper-' + suffix + '.zip'), zip)
}
