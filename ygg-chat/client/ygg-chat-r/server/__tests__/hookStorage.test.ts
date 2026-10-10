import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { retireLegacyMemoryHook } from '../hooks/hookStorage.js'

describe('retire bundled legacy memory writer', () => {
  let temp: string
  let managed: string
  const command = (value: string) => ({ type: 'command', command: value })
  async function write(file: string, content: string) {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, content)
  }
  beforeEach(async () => {
    temp = await fs.mkdtemp(path.join(os.tmpdir(), 'graviton-hooks-'))
    managed = path.join(temp, '.ygg')
    await fs.mkdir(managed)
  })
  afterEach(async () => {
    vi.unstubAllEnvs()
    vi.resetModules()
    await fs.rm(temp, { recursive: true, force: true })
  })

  it('removes only the bundled command, script and bytecode while preserving memories and other hooks', async () => {
    const script = path.join(managed, 'hooks', 'long_term_memory_stop.py')
    const rootNote = command('python3 .ygg/hooks/root_note_stop.py')
    const custom = command('python3 /custom/long_term_memory_stop.py')
    const echo = command('echo .ygg/hooks/long_term_memory_stop.py')
    for (const name of ['settings.json', 'settings.local.json']) {
      await write(path.join(managed, name), JSON.stringify({
        autoMemoryEnabled: false,
        hooks: { Stop: [{ matcher: '*', hooks: [rootNote, custom, echo, command('python3 .ygg/hooks/long_term_memory_stop.py'), command(`python3 "${script}"`)] }] },
      }))
    }
    await write(script, 'old writer')
    const bytecode = path.join(managed, 'hooks', '__pycache__', 'long_term_memory_stop.cpython-314.pyc')
    const otherBytecode = path.join(managed, 'hooks', '__pycache__', 'root_note_stop.cpython-314.pyc')
    await write(bytecode, 'old cache')
    await write(otherBytecode, 'keep')
    const memory = path.join(managed, 'memory', 'projects', 'Vega', 'project_memory.md')
    await write(memory, 'precious facts')
    await retireLegacyMemoryHook(managed)
    for (const name of ['settings.json', 'settings.local.json']) {
      const settings = JSON.parse(await fs.readFile(path.join(managed, name), 'utf8'))
      expect(settings.autoMemoryEnabled).toBe(false)
      expect(settings.hooks.Stop).toEqual([{ matcher: '*', hooks: [rootNote, custom, echo] }])
    }
    await expect(fs.access(script)).rejects.toThrow()
    await expect(fs.access(bytecode)).rejects.toThrow()
    expect(await fs.readFile(otherBytecode, 'utf8')).toBe('keep')
    expect(await fs.readFile(memory, 'utf8')).toBe('precious facts')
    await retireLegacyMemoryHook(managed)
  })

  it('does not overwrite malformed settings', async () => {
    const file = path.join(managed, 'settings.json')
    await write(file, '{broken')
    await expect(retireLegacyMemoryHook(managed)).rejects.toThrow('invalid JSON')
    expect(await fs.readFile(file, 'utf8')).toBe('{broken')
  })

  it.each(['missing', 'same', 'separate'])('retires installed hooks on initialization with a %s template directory', async mode => {
    vi.resetModules()
    const template = mode === 'same' ? managed : path.join(temp, 'template')
    vi.stubEnv('YGG_HOOKS_DIRECTORY', managed)
    vi.stubEnv('YGG_HOOKS_TEMPLATE_DIRECTORY', template)
    const old = { hooks: { Stop: [{ hooks: [command('python3 .ygg/hooks/long_term_memory_stop.py')] }] } }
    await write(path.join(managed, 'settings.json'), JSON.stringify(old))
    await write(path.join(managed, 'hooks', 'long_term_memory_stop.py'), 'old writer')
    if (mode === 'separate') {
      await write(path.join(template, 'settings.local.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [command('python3 .ygg/hooks/root_note_stop.py')] }] } }))
    }
    const { ensureManagedHooksInitialized } = await import('../hooks/hookStorage.js')
    await ensureManagedHooksInitialized()
    const settings = JSON.parse(await fs.readFile(path.join(managed, 'settings.json'), 'utf8'))
    expect(settings.hooks.Stop).toEqual([])
    await expect(fs.access(path.join(managed, 'hooks', 'long_term_memory_stop.py'))).rejects.toThrow()
  })
})
