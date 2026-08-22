// server/esbuild.server.mjs
// Build the standalone Ygg server bundle (no Electron).
//
// Output layout (dist-server/):
//   ygg-server.mjs                      server entrypoint bundle
//   toolRuntimeUtility.mjs              tool sandbox child (Node ABI, forked
//                                       by NodeToolRuntimeHost as a sibling)
//   prompts/*.md                        operation-mode prompt assets
//   headlessServer/ui/mobile/**         mobile LAN UI static assets
//   headlessServer/routes/testHarnessPage.html
//   .ygg/custom-themes/**               bundled theme templates (if present)
//
// 'electron' is deliberately NOT external: if any module reachable from the
// standalone entry imports it, this build fails. That is the mechanical proof
// that the server graph carries no Electron dependency.

import * as esbuild from 'esbuild'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.resolve(__dirname, '..')
const outDir = path.join(packageRoot, 'dist-server')

fs.mkdirSync(outDir, { recursive: true })

const sharedOptions = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  sourcemap: true,
  resolveExtensions: ['.ts', '.js', '.mjs', '.json'],
  banner: {
    js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
  },
}

// 1) Server entrypoint
await esbuild.build({
  ...sharedOptions,
  entryPoints: [path.join(__dirname, 'standaloneEntry.ts')],
  outfile: path.join(outDir, 'ygg-server.mjs'),
  external: [
    'better-sqlite3', // native module - must be external
    'keytar',
    'node-pty',
  ],
})
console.log('✅ standaloneEntry.ts bundled to dist-server/ygg-server.mjs')

// 2) Tool sandbox child for the Node ABI (same protocol/bundle as Electron's,
//    emitted next to the server bundle where NodeToolRuntimeHost resolves it)
await esbuild.build({
  ...sharedOptions,
  entryPoints: [path.join(__dirname, 'toolRuntimeUtility.ts')],
  outfile: path.join(outDir, 'toolRuntimeUtility.mjs'),
  external: ['better-sqlite3'],
})
console.log('✅ toolRuntimeUtility.ts bundled to dist-server/toolRuntimeUtility.mjs')

// 3) Static assets
function copyDir(source, target) {
  if (!fs.existsSync(source)) return false
  fs.mkdirSync(target, { recursive: true })
  fs.cpSync(source, target, { recursive: true })
  return true
}

function copyFile(source, target) {
  if (!fs.existsSync(source)) return false
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.copyFileSync(source, target)
  return true
}

const promptsSource = path.join(packageRoot, 'src', 'features', 'chats', 'prompts')
const promptsTarget = path.join(outDir, 'prompts')
fs.mkdirSync(promptsTarget, { recursive: true })
let promptCount = 0
for (const name of fs.readdirSync(promptsSource)) {
  if (name.endsWith('.md')) {
    fs.copyFileSync(path.join(promptsSource, name), path.join(promptsTarget, name))
    promptCount += 1
  }
}
if (promptCount === 0) {
  throw new Error(`No prompt assets found in ${promptsSource}`)
}
console.log(`✅ copied ${promptCount} prompt assets to dist-server/prompts`)

const mobileUiCopied = copyDir(
  path.join(__dirname, 'headlessServer', 'ui', 'mobile'),
  path.join(outDir, 'headlessServer', 'ui', 'mobile')
)
if (!mobileUiCopied) {
  throw new Error('Mobile UI assets missing; run build:electron:main once to produce them')
}
console.log('✅ copied mobile UI assets')

copyFile(
  path.join(__dirname, 'headlessServer', 'routes', 'testHarnessPage.html'),
  path.join(outDir, 'headlessServer', 'routes', 'testHarnessPage.html')
)

if (copyDir(path.join(packageRoot, '.ygg', 'custom-themes'), path.join(outDir, '.ygg', 'custom-themes'))) {
  console.log('✅ copied bundled theme templates')
}

console.log('✅ dist-server build complete')
