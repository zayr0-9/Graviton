import * as os from 'os'
import * as path from 'path'
import { promises as fs } from 'fs'
import { afterEach } from 'vitest'

export interface ToolFsHarness {
  workspaceDir: string
  absolutePath: (relativePath: string) => string
  writeFile: (relativePath: string, content: string) => Promise<string>
  readFile: (relativePath: string) => Promise<string>
  fileExists: (relativePath: string) => Promise<boolean>
  listBackups: (relativePath: string) => Promise<string[]>
}

const trackedWorkspaceDirs = new Set<string>()

afterEach(async () => {
  await Promise.all(
    Array.from(trackedWorkspaceDirs, async workspaceDir => {
      await fs.rm(workspaceDir, { recursive: true, force: true })
    })
  )
  trackedWorkspaceDirs.clear()
})

export async function createToolFsHarness(prefix: string = 'ygg-tool-test-'): Promise<ToolFsHarness> {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  trackedWorkspaceDirs.add(workspaceDir)

  function absolutePath(relativePath: string): string {
    return path.resolve(workspaceDir, relativePath)
  }

  async function writeFile(relativePath: string, content: string): Promise<string> {
    const fullPath = absolutePath(relativePath)
    await fs.mkdir(path.dirname(fullPath), { recursive: true })
    await fs.writeFile(fullPath, content, 'utf8')
    return fullPath
  }

  async function readFile(relativePath: string): Promise<string> {
    return fs.readFile(absolutePath(relativePath), 'utf8')
  }

  async function fileExists(relativePath: string): Promise<boolean> {
    try {
      await fs.access(absolutePath(relativePath))
      return true
    } catch {
      return false
    }
  }

  async function listBackups(relativePath: string): Promise<string[]> {
    const targetPath = absolutePath(relativePath)
    const directory = path.dirname(targetPath)
    const backupPrefix = `${path.basename(targetPath)}.backup.`

    const entries = await fs.readdir(directory)
    return entries
      .filter(entry => entry.startsWith(backupPrefix))
      .sort()
      .map(entry => path.join(directory, entry))
  }

  return {
    workspaceDir,
    absolutePath,
    writeFile,
    readFile,
    fileExists,
    listBackups,
  }
}
