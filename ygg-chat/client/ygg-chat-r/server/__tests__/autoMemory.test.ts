import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BUILTIN_TOOL_DEFINITIONS } from '../../../../shared/builtinToolDefinitions.js'
import { resolveAutoMemoryDirectory } from '../context/autoMemory.js'
import { ConversationContextLoader } from '../context/contextLoader.js'

describe('standard Markdown memory', () => {
  let temp: string
  let root: string
  let dataDir: string
  let homeDir: string

  beforeEach(async () => {
    temp = await fs.mkdtemp(path.join(os.tmpdir(), 'graviton-memory-'))
    root = path.join(temp, 'Vega', 'harness')
    dataDir = path.join(temp, 'data')
    homeDir = path.join(temp, 'home')
    await fs.mkdir(path.join(root, '.git'), { recursive: true })
    await fs.mkdir(homeDir, { recursive: true })
    for (const key of ['YGG_AUTO_MEMORY_DIRECTORY', 'YGG_MEMORY_PROJECT_DIR_NAME', 'YGG_DISABLE_AUTO_MEMORY']) {
      vi.stubEnv(key, '')
    }
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    await fs.rm(temp, { recursive: true, force: true })
  })

  async function write(file: string, content: string) {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, content)
  }

  function loader(rootPath = root, autoMemoryEnabled = true) {
    return new ConversationContextLoader({
      conversationId: 'chat', rootPath, dataDir, homeDir, autoMemoryEnabled,
      settings: { readDirs: ['.ygg'], writeDir: '.ygg' },
    })
  }

  it('uses the nearest repo root for subdirectories, not the sidebar project name', async () => {
    const directory = resolveAutoMemoryDirectory({ dataDir, rootPath: root })
    expect(directory).toBe(path.join(dataDir, '.ygg', 'memory', 'projects', root.replace(/[^A-Za-z0-9._-]+/g, '-')))
    expect(await loader(path.join(root, 'src')).getAutoMemoryDirectory()).toBe(directory)
    expect(await loader(path.dirname(root)).getAutoMemoryDirectory()).not.toBe(directory)
  })

  it('ignores preserved legacy files and advertises the correct directory when the index is missing', async () => {
    const legacy = path.join(dataDir, '.ygg', 'memory', 'projects', 'Vega', 'project_memory.md')
    await write(legacy, 'old project facts')
    await write(path.join(dataDir, '.ygg', 'memory', 'memory.md'), 'old global facts')
    await write(path.join(dataDir, '.ygg', 'memory', 'recent_memory.md'), 'old recent facts')
    const context = loader()
    expect(await context.buildLaunchInjection(new Set())).toBeNull()
    expect((await context.buildSystemPromptParts()).autoMemoryPrompt).toContain(await context.getAutoMemoryDirectory())
    expect(await fs.readFile(legacy, 'utf8')).toBe('old project facts')
  })

  it('injects only the index, deduplicates it, and reloads it after compaction', async () => {
    const context = loader()
    const directory = (await context.getAutoMemoryDirectory())!
    const index = path.join(directory, 'MEMORY.md')
    await write(index, '- [Deployment](deployment.md) — deployment policy')
    await write(path.join(directory, 'deployment.md'), 'fact body read on demand')
    const launch = await context.buildLaunchInjection(new Set())
    expect(launch?.files).toEqual([index])
    expect(launch?.text).toContain('deployment policy')
    expect(launch?.text).not.toContain('fact body read on demand')
    expect(await context.buildLaunchInjection(new Set([index]))).toBeNull()
    await write(index, 'updated index')
    expect((await context.buildPostCompactionInjection([]))?.text).toContain('updated index')
  })

  it('honors an explicit shared directory override and the auto-memory toggle', async () => {
    const shared = path.join(temp, 'shared-memory')
    await write(path.join(root, '.ygg', 'settings.json'), JSON.stringify({ autoMemoryDirectory: shared }))
    await write(path.join(shared, 'MEMORY.md'), 'shared index')
    expect(await loader().getAutoMemoryDirectory()).toBe(shared)
    expect((await loader().buildLaunchInjection(new Set()))?.text).toContain('shared index')
    expect(await loader(root, false).buildLaunchInjection(new Set())).toBeNull()
    expect((await loader(root, false).buildSystemPromptParts()).autoMemoryPrompt).toBeNull()
  })

  it('does not advertise the retired memory-specific tool', () => {
    expect(BUILTIN_TOOL_DEFINITIONS.some(tool => tool.name === 'memory_manage')).toBe(false)
    expect(BUILTIN_TOOL_DEFINITIONS.some(tool => tool.name === 'read_file')).toBe(true)
    expect(BUILTIN_TOOL_DEFINITIONS.some(tool => tool.name === 'edit_file')).toBe(true)
  })
})
