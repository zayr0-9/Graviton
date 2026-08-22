import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import os from 'os'
import path from 'path'
import { promises as fs } from 'fs'

const originalEnv = process.env.YGG_CUSTOM_TOOLS_DIRECTORY

async function writeTool(rootDir: string, dirName: string, toolName = dirName) {
  const toolDir = path.join(rootDir, 'custom-tools', dirName)
  await fs.mkdir(toolDir, { recursive: true })
  await fs.writeFile(
    path.join(toolDir, 'definition.json'),
    JSON.stringify(
      {
        name: toolName,
        description: 'Test custom tool',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      null,
      2
    ),
    'utf8'
  )
  await fs.writeFile(
    path.join(toolDir, 'index.js'),
    'export async function execute() { return { success: true } }\n',
    'utf8'
  )
}

describe('customToolRegistry resource directory behavior', () => {
  let tempRoot: string

  beforeEach(async () => {
    vi.resetModules()
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'custom-tool-loader-'))
    process.env.YGG_CUSTOM_TOOLS_DIRECTORY = tempRoot
  })

  afterEach(async () => {
    if (originalEnv === undefined) {
      delete process.env.YGG_CUSTOM_TOOLS_DIRECTORY
    } else {
      process.env.YGG_CUSTOM_TOOLS_DIRECTORY = originalEnv
    }
    await fs.rm(tempRoot, { recursive: true, force: true })
  })

  it('creates the shared resources directory during initialization', async () => {
    const { ensureManagedCustomToolsInitialized } = await import('../customToolLoader.js')

    const customToolsDir = await ensureManagedCustomToolsInitialized()

    expect(customToolsDir).toBe(path.join(tempRoot, 'custom-tools'))

    const resourcesDir = path.join(tempRoot, 'custom-tools', 'resources')
    const stat = await fs.stat(resourcesDir)
    expect(stat.isDirectory()).toBe(true)
  })

  it('does not treat the shared resources folder as a tool directory', async () => {
    await writeTool(tempRoot, 'alpha_tool')
    await fs.mkdir(path.join(tempRoot, 'custom-tools', 'resources', 'alpha_tool'), { recursive: true })

    const { customToolRegistry } = await import('../customToolLoader.js')
    await customToolRegistry.initialize()

    const defs = customToolRegistry.getDefinitions()
    expect(defs.map(def => def.name)).toEqual(['alpha_tool'])
  })
})
