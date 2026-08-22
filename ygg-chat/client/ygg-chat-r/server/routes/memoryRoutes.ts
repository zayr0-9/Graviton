// server/routes/memoryRoutes.ts
//
// Long-term memory file APIs (/api/memory/*) plus the memory_manage
// built-in tool handler, extracted verbatim from localServer.ts
// setupServer(). The tool handler registers into the shared
// builtInTools map and stays beside its routes on purpose.

import type { Express } from 'express'
import fs from 'fs'
import path from 'path'
import type { BuiltInToolHandler } from '../builtinToolRegistry.js'
import { getServerDataDir } from '../serverHost.js'

export interface MemoryRoutesDeps {
  statements: any
  builtInTools: Map<string, BuiltInToolHandler>
}

export function registerMemoryRoutes(app: Express, deps: MemoryRoutesDeps): void {
  const { statements, builtInTools } = deps

  const getLongTermMemoryDirectory = () => path.join(getServerDataDir(), '.ygg', 'memory')
  const getLongTermMemoryFilePath = () => path.join(getLongTermMemoryDirectory(), 'memory.md')
  const getRecentMemoryFilePath = () => path.join(getLongTermMemoryDirectory(), 'recent_memory.md')
  const sanitizeMemoryProjectDirectoryName = (projectName: string, projectId?: string | null) => {
    const raw = (projectName || projectId || '').trim()
    if (!raw) return ''
    return raw
      .replace(/[\\/\0:*?"<>|]+/g, '-')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^[.\s]+|[.\s]+$/g, '')
      .slice(0, 80)
      .trim()
      .replace(/^[.\s]+|[.\s]+$/g, '')
  }
  const getProjectMemoryFilePath = (projectName: string, projectId?: string | null) => {
    const safeName = sanitizeMemoryProjectDirectoryName(projectName, projectId)
    return safeName ? path.join(getLongTermMemoryDirectory(), 'projects', safeName, 'project_memory.md') : ''
  }

  type MemoryFileKind = 'global' | 'recent' | 'project'

  interface MemoryFileSummary {
    id: string
    kind: MemoryFileKind
    label: string
    description?: string
    projectName?: string | null
    exists: boolean
    path: string
    sizeBytes: number | null
    updatedAt: string | null
  }

  const readMemoryFileForContext = async (filePath: string, maxChars: number): Promise<{ exists: boolean; memory: string }> => {
    try {
      const raw = await fs.promises.readFile(filePath, 'utf8')
      return { exists: true, memory: maxChars > 0 && raw.length > maxChars ? raw.slice(-maxChars) : raw }
    } catch (readError: any) {
      if (readError?.code !== 'ENOENT') {
        throw readError
      }
      return { exists: false, memory: '' }
    }
  }

  const getMemoryFileStat = async (filePath: string): Promise<Pick<MemoryFileSummary, 'exists' | 'sizeBytes' | 'updatedAt'>> => {
    try {
      const stat = await fs.promises.stat(filePath)
      if (!stat.isFile()) {
        return { exists: false, sizeBytes: null, updatedAt: null }
      }
      return { exists: true, sizeBytes: stat.size, updatedAt: stat.mtime.toISOString() }
    } catch (statError: any) {
      if (statError?.code !== 'ENOENT') {
        throw statError
      }
      return { exists: false, sizeBytes: null, updatedAt: null }
    }
  }

  const buildMemoryFileSummary = async (
    input: Omit<MemoryFileSummary, 'exists' | 'sizeBytes' | 'updatedAt'>
  ): Promise<MemoryFileSummary> => {
    const stat = await getMemoryFileStat(input.path)
    return { ...input, ...stat }
  }

  const listMemoryFileSummaries = async (): Promise<MemoryFileSummary[]> => {
    const memoryDirectory = getLongTermMemoryDirectory()
    const files: MemoryFileSummary[] = [
      await buildMemoryFileSummary({
        id: 'global:memory',
        kind: 'global',
        label: 'Long-term memory',
        description: 'memory.md',
        path: getLongTermMemoryFilePath(),
      }),
      await buildMemoryFileSummary({
        id: 'global:recent',
        kind: 'recent',
        label: 'Recent memory',
        description: 'recent_memory.md',
        path: getRecentMemoryFilePath(),
      }),
    ]

    const projectsDirectory = path.join(memoryDirectory, 'projects')
    try {
      const entries = await fs.promises.readdir(projectsDirectory, { withFileTypes: true })
      const projectFiles = await Promise.all(
        entries
          .filter(entry => entry.isDirectory())
          .map(async entry =>
            buildMemoryFileSummary({
              id: `project:${encodeURIComponent(entry.name)}`,
              kind: 'project',
              label: entry.name,
              description: 'project_memory.md',
              projectName: entry.name,
              path: path.join(projectsDirectory, entry.name, 'project_memory.md'),
            })
          )
      )
      files.push(...projectFiles.filter(file => file.exists))
    } catch (readError: any) {
      if (readError?.code !== 'ENOENT') {
        throw readError
      }
    }

    return files
  }

  builtInTools.set('memory_manage', async () => {
    const files = await listMemoryFileSummaries()
    return {
      success: true,
      files: files
        .filter(file => file.exists)
        .map(({ kind, label, projectName, path: filePath }) => ({
          kind,
          label,
          ...(projectName ? { projectName } : {}),
          path: filePath,
        })),
    }
  })

  const resolveMemoryFileId = (id: string): { path: string; kind: MemoryFileKind; projectName?: string | null } | null => {
    if (id === 'global:memory') return { path: getLongTermMemoryFilePath(), kind: 'global' }
    if (id === 'global:recent') return { path: getRecentMemoryFilePath(), kind: 'recent' }

    if (!id.startsWith('project:')) return null
    const encodedProjectName = id.slice('project:'.length)
    let projectName = ''
    try {
      projectName = decodeURIComponent(encodedProjectName)
    } catch {
      return null
    }

    if (!projectName || projectName.includes('/') || projectName.includes('\\') || projectName.includes('\0') || projectName.includes('..')) {
      return null
    }

    const projectPath = path.join(getLongTermMemoryDirectory(), 'projects', projectName, 'project_memory.md')
    const memoryRoot = path.resolve(getLongTermMemoryDirectory())
    const resolvedProjectPath = path.resolve(projectPath)
    if (resolvedProjectPath !== memoryRoot && !resolvedProjectPath.startsWith(`${memoryRoot}${path.sep}`)) {
      return null
    }

    return { path: projectPath, kind: 'project', projectName }
  }

  app.get('/api/memory/context', async (req, res) => {
    try {
      const maxCharsRaw = Number(req.query?.maxChars ?? 10000)
      const recentMaxCharsRaw = Number(req.query?.recentMaxChars ?? maxCharsRaw)
      const projectMaxCharsRaw = Number(req.query?.projectMaxChars ?? 12000)
      const maxChars = Number.isFinite(maxCharsRaw) ? Math.max(0, Math.min(Math.floor(maxCharsRaw), 100000)) : 10000
      const recentMaxChars = Number.isFinite(recentMaxCharsRaw)
        ? Math.max(0, Math.min(Math.floor(recentMaxCharsRaw), 100000))
        : maxChars
      const projectMaxChars = Number.isFinite(projectMaxCharsRaw)
        ? Math.max(0, Math.min(Math.floor(projectMaxCharsRaw), 100000))
        : 12000
      const projectId = typeof req.query?.projectId === 'string' && req.query.projectId.trim() ? req.query.projectId.trim() : null
      let projectName = typeof req.query?.projectName === 'string' && req.query.projectName.trim() ? req.query.projectName.trim() : null
      if (projectId && !projectName) {
        const project = statements.getProjectById.get(projectId) as { name?: string | null } | undefined
        projectName = typeof project?.name === 'string' && project.name.trim() ? project.name.trim() : null
      }
      const memoryPath = getLongTermMemoryFilePath()
      const recentMemoryPath = getRecentMemoryFilePath()
      const projectMemoryPath = projectName || projectId ? getProjectMemoryFilePath(projectName || '', projectId) : ''
      const { exists, memory } = await readMemoryFileForContext(memoryPath, maxChars)
      const { exists: recentExists, memory: recentMemory } = await readMemoryFileForContext(
        recentMemoryPath,
        recentMaxChars
      )
      const { exists: projectExists, memory: projectMemory } = projectMemoryPath
        ? await readMemoryFileForContext(projectMemoryPath, projectMaxChars)
        : { exists: false, memory: '' }

      if (/^(1|true|yes|on)$/i.test(process.env.YGG_HOOK_DEBUG_LOGS || '')) {
        console.info('[LocalServer][memory] Context read', {
          exists,
          recentExists,
          projectExists,
          path: memoryPath,
          recentPath: recentMemoryPath,
          projectPath: projectMemoryPath,
          projectId,
          projectName,
          maxChars,
          recentMaxChars,
          projectMaxChars,
          returnedChars: memory.length,
          returnedRecentChars: recentMemory.length,
          returnedProjectChars: projectMemory.length,
        })
      }

      res.json({
        success: true,
        exists,
        recentExists,
        projectExists,
        memory,
        recentMemory,
        projectMemory,
        path: memoryPath,
        recentPath: recentMemoryPath,
        projectPath: projectMemoryPath || null,
        projectId,
        projectName,
      })
    } catch (error) {
      console.error('[LocalServer] Memory context error:', error)
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : String(error),
        memory: '',
        recentMemory: '',
        projectMemory: '',
      })
    }
  })

  app.get('/api/memory/files', async (_req, res) => {
    try {
      const files = await listMemoryFileSummaries()
      res.json({ success: true, files, directory: getLongTermMemoryDirectory() })
    } catch (error) {
      console.error('[LocalServer] Memory file list error:', error)
      res.status(500).json({ success: false, error: error instanceof Error ? error.message : String(error), files: [] })
    }
  })

  app.get('/api/memory/file', async (req, res) => {
    try {
      const id = typeof req.query?.id === 'string' ? req.query.id.trim() : ''
      const resolved = resolveMemoryFileId(id)
      if (!resolved) {
        res.status(400).json({ success: false, error: 'Invalid memory file id.', content: '' })
        return
      }

      const files = await listMemoryFileSummaries()
      const file = files.find(item => item.id === id) || null
      let content = ''
      try {
        const stat = await fs.promises.stat(resolved.path)
        if (!stat.isFile()) {
          res.status(404).json({ success: false, error: 'Memory file not found.', content: '', file })
          return
        }
        if (stat.size > 2 * 1024 * 1024) {
          res.status(413).json({ success: false, error: 'Memory file is too large to preview.', content: '', file })
          return
        }
        content = await fs.promises.readFile(resolved.path, 'utf8')
      } catch (readError: any) {
        if (readError?.code !== 'ENOENT') throw readError
      }

      res.json({ success: true, file, content })
    } catch (error) {
      console.error('[LocalServer] Memory file read error:', error)
      res.status(500).json({ success: false, error: error instanceof Error ? error.message : String(error), content: '' })
    }
  })

  app.get('/api/memory/path', (req, res) => {
    try {
      const projectId = typeof req.query?.projectId === 'string' && req.query.projectId.trim() ? req.query.projectId.trim() : null
      let projectName = typeof req.query?.projectName === 'string' && req.query.projectName.trim() ? req.query.projectName.trim() : null
      if (projectId && !projectName) {
        const project = statements.getProjectById.get(projectId) as { name?: string | null } | undefined
        projectName = typeof project?.name === 'string' && project.name.trim() ? project.name.trim() : null
      }
      res.json({
        success: true,
        path: getLongTermMemoryFilePath(),
        recentPath: getRecentMemoryFilePath(),
        projectPath: projectName || projectId ? getProjectMemoryFilePath(projectName || '', projectId) : null,
        projectId,
        projectName,
        directory: getLongTermMemoryDirectory(),
      })
    } catch (error) {
      res.status(500).json({ success: false, error: error instanceof Error ? error.message : String(error) })
    }
  })
}
