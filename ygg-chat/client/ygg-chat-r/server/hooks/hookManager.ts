import fs from 'fs/promises'
import path from 'path'
import { ensureManagedHooksInitialized } from './hookStorage.js'
import type { HookEventName, HookExecutionMode } from './hookTypes.js'

const HOOK_EVENT_NAMES: HookEventName[] = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop']

type HookHandlerLocation = 'entry' | 'hooks'

type HookToggleTarget = {
  sourceFile: string
  event: HookEventName
  entryIndex: number
  handlerIndex: number
  handlerLocation: HookHandlerLocation
  enabled: boolean
}

export type ManagedHookListItem = {
  id: string
  event: HookEventName
  command: string
  timeoutMs?: number
  matcher?: string | string[]
  enabled: boolean
  sourceFile: string
  sourceFileName: string
  entryIndex: number
  handlerIndex: number
  handlerLocation: HookHandlerLocation
  executionMode?: HookExecutionMode
}

type JsonRecord = Record<string, unknown>

type HookSettingsDocument = {
  hooks?: Record<string, unknown>
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function toTrimmedString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function parseExecutionMode(value: unknown): HookExecutionMode | undefined {
  const mode = toTrimmedString(value)?.toLowerCase()
  return mode === 'sync' || mode === 'async' ? mode : undefined
}

function toEventEntries(rawValue: unknown): unknown[] {
  if (Array.isArray(rawValue)) return rawValue
  if (rawValue == null) return []
  return [rawValue]
}

function buildHookId(item: {
  sourceFile: string
  event: HookEventName
  entryIndex: number
  handlerIndex: number
  handlerLocation: HookHandlerLocation
}): string {
  return [item.sourceFile, item.event, item.entryIndex, item.handlerLocation, item.handlerIndex].join('::')
}

function extractManagedHookItemsFromEntry(
  rawEntry: unknown,
  sourceFile: string,
  event: HookEventName,
  entryIndex: number
): ManagedHookListItem[] {
  if (!isRecord(rawEntry)) return []

  const entryMatcher = rawEntry.matcher as string | string[] | undefined
  const entryEnabled = rawEntry.enabled !== false
  const nestedHandlers = Array.isArray(rawEntry.hooks) ? rawEntry.hooks : null

  if (nestedHandlers) {
    return nestedHandlers.flatMap((rawHandler, handlerIndex) => {
      if (!isRecord(rawHandler)) return []
      const command = toTrimmedString(rawHandler.command)
      const type = toTrimmedString(rawHandler.type)?.toLowerCase() ?? (command ? 'command' : null)
      if (type !== 'command' || !command) return []

      const item: ManagedHookListItem = {
        id: buildHookId({ sourceFile, event, entryIndex, handlerIndex, handlerLocation: 'hooks' }),
        event,
        command,
        timeoutMs: typeof rawHandler.timeoutMs === 'number' ? rawHandler.timeoutMs : undefined,
        matcher: (rawHandler.matcher as string | string[] | undefined) ?? entryMatcher,
        enabled: entryEnabled && rawHandler.enabled !== false,
        executionMode: parseExecutionMode(rawHandler.executionMode),
        sourceFile,
        sourceFileName: path.basename(sourceFile),
        entryIndex,
        handlerIndex,
        handlerLocation: 'hooks',
      }

      return [item]
    })
  }

  const command = toTrimmedString(rawEntry.command)
  const type = toTrimmedString(rawEntry.type)?.toLowerCase() ?? (command ? 'command' : null)
  if (type !== 'command' || !command) return []

  return [
    {
      id: buildHookId({ sourceFile, event, entryIndex, handlerIndex: 0, handlerLocation: 'entry' }),
      event,
      command,
      timeoutMs: typeof rawEntry.timeoutMs === 'number' ? rawEntry.timeoutMs : undefined,
      matcher: entryMatcher,
      enabled: entryEnabled,
      executionMode: parseExecutionMode(rawEntry.executionMode),
      sourceFile,
      sourceFileName: path.basename(sourceFile),
      entryIndex,
      handlerIndex: 0,
      handlerLocation: 'entry',
    },
  ]
}

async function getManagedSettingsFiles(): Promise<string[]> {
  const managedHooksDir = await ensureManagedHooksInitialized()
  const candidateFiles = ['settings.json', 'settings.local.json'].map(fileName => path.join(managedHooksDir, fileName))
  const existingFiles = await Promise.all(
    candidateFiles.map(async filePath => {
      try {
        await fs.access(filePath)
        return filePath
      } catch {
        return null
      }
    })
  )

  return existingFiles.filter((filePath): filePath is string => Boolean(filePath))
}

async function readSettingsFile(filePath: string): Promise<HookSettingsDocument> {
  const raw = await fs.readFile(filePath, 'utf8')
  const parsed = JSON.parse(raw)
  if (!isRecord(parsed)) {
    throw new Error(`Invalid hook settings file: ${path.basename(filePath)}`)
  }
  return parsed as HookSettingsDocument
}

export async function listManagedHooks(): Promise<ManagedHookListItem[]> {
  const files = await getManagedSettingsFiles()
  const items: ManagedHookListItem[] = []

  for (const filePath of files) {
    const parsed = await readSettingsFile(filePath)
    const hooks = isRecord(parsed.hooks) ? parsed.hooks : {}

    for (const event of HOOK_EVENT_NAMES) {
      const eventEntries = toEventEntries(hooks[event])
      eventEntries.forEach((entry, entryIndex) => {
        items.push(...extractManagedHookItemsFromEntry(entry, filePath, event, entryIndex))
      })
    }
  }

  return items
}

export async function setManagedHookEnabled(target: HookToggleTarget): Promise<ManagedHookListItem> {
  const parsed = await readSettingsFile(target.sourceFile)
  if (!isRecord(parsed.hooks)) {
    throw new Error(`No hooks found in ${path.basename(target.sourceFile)}`)
  }

  const rawEventValue = parsed.hooks[target.event]
  const entry = Array.isArray(rawEventValue)
    ? rawEventValue[target.entryIndex]
    : target.entryIndex === 0
      ? rawEventValue
      : undefined

  if (!isRecord(entry)) {
    throw new Error('Hook entry not found')
  }

  if (target.handlerLocation === 'entry') {
    entry.enabled = target.enabled
  } else {
    const handlers = Array.isArray(entry.hooks) ? entry.hooks : null
    const handler = handlers?.[target.handlerIndex]
    if (!isRecord(handler)) {
      throw new Error('Hook handler not found')
    }
    handler.enabled = target.enabled
  }

  await fs.writeFile(target.sourceFile, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8')

  const items = extractManagedHookItemsFromEntry(entry, target.sourceFile, target.event, target.entryIndex)
  const updatedItem = items.find(item => item.handlerLocation === target.handlerLocation && item.handlerIndex === target.handlerIndex)
  if (!updatedItem) {
    throw new Error('Updated hook could not be resolved')
  }

  return updatedItem
}
