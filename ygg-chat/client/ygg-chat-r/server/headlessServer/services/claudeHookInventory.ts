import { constants } from 'node:fs'
import { open, realpath, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ClaudeHookDeclaration, ClaudeHookInventory, ClaudeHookSettingsSource } from '../../../../../shared/claudeHookInventory.js'

const MAX_SETTINGS_BYTES = 512 * 1024
const MAX_HOOKS = 200
const HOOK_TYPES = new Set(['command', 'http', 'prompt', 'agent', 'mcp_tool'])

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

async function readSource(root: string, file: string, source: ClaudeHookSettingsSource['source'], label = file): Promise<ClaudeHookSettingsSource> {
  const view: ClaudeHookSettingsSource = { source, file: label, status: 'read', hooks: [] }
  try {
    const target = path.join(await realpath(root), file)
    // Do not follow a repo-controlled .claude directory or settings symlink out of the folder.
    if (await realpath(target) !== target) return { ...view, status: 'unreadable' }
    const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
    const handle = await open(target, flags)
    try {
      const info = await handle.stat()
      const current = await stat(target)
      if (!info.isFile() || await realpath(target) !== target || info.dev !== current.dev || info.ino !== current.ino) return { ...view, status: 'unreadable' }
      if (info.size > MAX_SETTINGS_BYTES) return { ...view, status: 'limited' }
      const buffer = Buffer.alloc(MAX_SETTINGS_BYTES + 1)
      let length = 0
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length)
        if (!bytesRead) break
        length += bytesRead
      }
      if (length > MAX_SETTINGS_BYTES) return { ...view, status: 'limited' }
      const settings = record(JSON.parse(buffer.toString('utf8', 0, length).replace(/^\uFEFF/, '')))
      if (!settings) return { ...view, status: 'invalid' }
      if (settings.hooks === undefined) return view
      const hooks = record(settings.hooks)
      if (!hooks) return { ...view, status: 'invalid' }
      const declarations: ClaudeHookDeclaration[] = []
      for (const [event, groups] of Object.entries(hooks)) {
        if (!/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(event) || !Array.isArray(groups)) { view.status = 'invalid'; continue }
        for (const group of groups) {
          const matcherGroup = record(group)
          if (!Array.isArray(matcherGroup?.hooks)) { view.status = 'invalid'; continue }
          const matcher = typeof matcherGroup.matcher === 'string' ? matcherGroup.matcher.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, 120) || null : null
          for (const handler of matcherGroup.hooks) {
            const type = record(handler)?.type
            if (typeof type !== 'string') { view.status = 'invalid'; continue }
            if (declarations.length === MAX_HOOKS) return { ...view, status: 'limited', hooks: declarations }
            declarations.push({ event, matcher, type: HOOK_TYPES.has(type) ? type : 'unknown' })
          }
        }
      }
      return { ...view, hooks: declarations }
    } finally { await handle.close() }
  } catch (error) {
    const status = error instanceof SyntaxError ? 'invalid' : (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'missing' : 'unreadable'
    return { ...view, status }
  }
}

/** An inventory of declarations, not the CLI's effective hook set. Never starts Claude. */
export async function readClaudeHookInventory(cwd: string | null, configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')): Promise<ClaudeHookInventory> {
  const sources = await Promise.all([
    ...(cwd ? [readSource(cwd, '.claude/settings.json', 'project'), readSource(cwd, '.claude/settings.local.json', 'local')] : []),
    readSource(path.resolve(cwd ?? process.cwd(), configDir), 'settings.json', 'user', process.env.CLAUDE_CONFIG_DIR ? 'Claude config directory/settings.json' : '~/.claude/settings.json'),
  ])
  return { cwd, sources }
}
