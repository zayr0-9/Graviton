import Conf from 'conf'

const LSP_COMMANDS_STORAGE_KEY = 'lsp.serverCommands'
const PROJECT_NAME = 'ygg-chat-r'

const memoryCommandOverrides = new Map<string, string>()
let storeInstance: Conf<Record<string, unknown>> | null | undefined

function trimValue(value: unknown): string {
  return String(value || '').trim()
}

function getStore(): Conf<Record<string, unknown>> | null {
  if (storeInstance !== undefined) {
    return storeInstance
  }

  try {
    storeInstance = new Conf<Record<string, unknown>>({
      projectName: PROJECT_NAME,
      configFileMode: 0o600,
    })
  } catch (error) {
    console.warn('[LSP] Failed to initialize LSP settings store; using in-memory fallback.', error)
    storeInstance = null
  }

  return storeInstance
}

function normalizeCommandMap(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {}
  }

  const entries = Object.entries(raw)
    .map(([serverId, command]) => [trimValue(serverId), trimValue(command)] as const)
    .filter(([serverId, command]) => Boolean(serverId && command))

  return Object.fromEntries(entries)
}

function readStoredCommandMap(): Record<string, string> {
  const store = getStore()
  if (!store) {
    return Object.fromEntries(memoryCommandOverrides.entries())
  }

  try {
    return normalizeCommandMap(store.get(LSP_COMMANDS_STORAGE_KEY))
  } catch (error) {
    console.warn('[LSP] Failed to read configured LSP command overrides; using in-memory fallback.', error)
    return Object.fromEntries(memoryCommandOverrides.entries())
  }
}

function writeStoredCommandMap(commands: Record<string, string>): void {
  const normalizedCommands = normalizeCommandMap(commands)

  memoryCommandOverrides.clear()
  for (const [serverId, command] of Object.entries(normalizedCommands)) {
    memoryCommandOverrides.set(serverId, command)
  }

  const store = getStore()
  if (!store) {
    return
  }

  try {
    if (Object.keys(normalizedCommands).length === 0) {
      store.delete(LSP_COMMANDS_STORAGE_KEY)
      return
    }

    store.set(LSP_COMMANDS_STORAGE_KEY, normalizedCommands)
  } catch (error) {
    console.warn('[LSP] Failed to persist configured LSP command overrides.', error)
  }
}

export function listConfiguredLspCommands(): Record<string, string> {
  return readStoredCommandMap()
}

export function getConfiguredLspCommand(serverId: string): string | null {
  const normalizedServerId = trimValue(serverId)
  if (!normalizedServerId) return null

  const commands = readStoredCommandMap()
  return commands[normalizedServerId] || null
}

export function setConfiguredLspCommand(serverId: string, command: string | null | undefined): string | null {
  const normalizedServerId = trimValue(serverId)
  if (!normalizedServerId) {
    throw new Error('serverId is required.')
  }

  const normalizedCommand = trimValue(command)
  const commands = readStoredCommandMap()

  if (normalizedCommand) {
    commands[normalizedServerId] = normalizedCommand
  } else {
    delete commands[normalizedServerId]
  }

  writeStoredCommandMap(commands)
  return commands[normalizedServerId] || null
}
