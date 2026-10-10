import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { runTasks } from './build-tasks.mjs'
import beforePack, { collectRuntimePackages, runtimeExclusions } from './runtime-packaging.mjs'

const require = createRequire(import.meta.url)
const { getNodeModuleFileMatcher, getMainFileMatchers } = require('app-builder-lib/out/fileMatcher.js')
const appDir = fileURLToPath(new URL('../', import.meta.url))

function filterFor(names) {
  const matcher = getNodeModuleFileMatcher(appDir, '/output', value => value, {}, {
    config: { files: runtimeExclusions(names) }, debugLogger: { isEnabled: false },
  })
  const filter = matcher.createFilter()
  return (relative, directory = false) => filter(path.join(appDir, relative), {
    moduleFullFilePath: relative,
    isDirectory: () => directory,
  })
}

test('builder filter keeps runtime trees and nested versions, excludes bundled packages', () => {
  const keep = filterFor(['better-sqlite3', 'bindings', 'file-uri-to-path', '@scope/needed', 'sqlite-vec-darwin-arm64'])
  for (const file of ['better-sqlite3/lib/index.js', 'bindings/node_modules/file-uri-to-path/index.js', '@scope/needed/index.js', 'sqlite-vec-darwin-arm64/vec0.dylib']) {
    assert.equal(keep(`node_modules/${file}`), true, file)
  }
  for (const file of ['mermaid/dist/mermaid.js', 'monaco-editor/package.json', '@scope/unneeded/index.js', '@other/package/index.js']) {
    assert.equal(keep(`node_modules/${file}`), false, file)
  }
  assert.equal(keep('node_modules/mermaid/dist', true), false)
  assert.equal(keep('node_modules/@scope/needed', true), true)
  assert.equal(keep('electron/main.mjs'), true)
})

test('runtime dependency discovery handles exports maps, nested deps, optional deps, and cycles', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'graviton-packaging-'))
  function pkg(relative, manifest) {
    const dir = path.join(root, relative)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest))
  }
  try {
    pkg('node_modules/runtime', { name: 'runtime', exports: './index.js', dependencies: { nested: '1', cycle: '1' }, optionalDependencies: { absent: '1' } })
    pkg('node_modules/runtime/node_modules/nested', { name: 'nested' })
    pkg('node_modules/cycle', { name: 'cycle', dependencies: { runtime: '1' } })
    assert.deepEqual(collectRuntimePackages(root, ['runtime']), ['cycle', 'nested', 'runtime'])
    assert.throws(() => collectRuntimePackages(root, ['missing']), /Missing packaged runtime dependency/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('real dependency closure keeps dynamic/native packages but not renderer packages', () => {
  const names = collectRuntimePackages(appDir)
  for (const name of ['better-sqlite3', 'keytar', 'node-pty', 'sqlite-vec', 'electron-updater', 'bindings', 'file-uri-to-path']) {
    assert.ok(names.includes(name), name)
  }
  for (const name of ['mermaid', 'monaco-editor', 'react', 'pdfjs-dist', 'three']) {
    assert.equal(names.includes(name), false, name)
  }
})

test('packaging hook is repeatable and preserves ZIP and native rebuilding', async () => {
  const config = JSON.parse(fs.readFileSync(path.join(appDir, 'electron-builder.json'), 'utf8'))
  config.files = [{ filter: config.files }]
  const context = { packager: { info: { appDir, config } }, arch: process.arch === 'arm64' ? 3 : 1, electronPlatformName: process.platform }
  await beforePack(context)
  const first = structuredClone(config.files)
  await beforePack(context)
  assert.deepEqual(config.files, first)
  assert.equal(config.npmRebuild, true)
  const matchers = getMainFileMatchers(appDir, '/output', value => value, {}, {
    info: { config, projectDir: appDir, buildResourcesDir: 'build', debugLogger: { isEnabled: false } },
  }, path.join(appDir, 'release'), false)
  for (const relative of ['.env', 'release/old.zip', 'src/App.tsx', 'package-lock.json']) {
    assert.equal(matchers.some(matcher => matcher.createFilter()(path.join(appDir, relative), { isDirectory: () => false })), false, relative)
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'))
  assert.match(manifest.scripts['build:mac'], /&& electron-builder --mac zip$/)
})

test('task pool limits concurrency and completes every successful task', async () => {
  let active = 0
  let peak = 0
  let completed = 0
  await runTasks(Array.from({ length: 5 }, () => async () => {
    active++
    peak = Math.max(peak, active)
    await new Promise(resolve => setTimeout(resolve, 5))
    active--
    completed++
  }))
  assert.equal(peak, 2)
  assert.equal(completed, 5)
})

test('failed tasks block scheduling and wait for active writers before rejecting', async () => {
  let finished = false
  let scheduled = false
  await assert.rejects(runTasks([
    async () => { throw new Error('check failed') },
    async () => { await new Promise(resolve => setTimeout(resolve, 10)); finished = true },
    async () => { scheduled = true },
  ]), /check failed/)
  assert.equal(finished, true)
  assert.equal(scheduled, false)
})
