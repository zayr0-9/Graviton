// electron/tools/customToolLoader.ts
// Dynamic loader for user-defined custom tools from userData/custom-tools/

import Conf from 'conf'
import { EventEmitter } from 'events'
import fs, { FSWatcher } from 'fs'
import fsPromises from 'fs/promises'
import { createRequire as createNodeRequire } from 'module'
import path from 'path'
import { pathToFileURL } from 'url'

const CUSTOM_TOOLS_DIR_NAME = 'custom-tools'
const CUSTOM_TOOLS_RESOURCES_DIR_NAME = 'resources'
const CUSTOM_TOOLS_GUIDE_FILE = 'CUSTOM_TOOLS_GUIDE.md'
const CUSTOM_TOOLS_STATE_FILE = 'custom-tools-state.json'
const DEFINITION_FILE = 'definition.json'
const IMPLEMENTATION_FILE = 'index.js'
const TOOL_EXECUTION_SETTINGS_STORAGE_KEY = 'ygg_tool_execution_settings'
const DEFAULT_EXECUTION_TIMEOUT_MS = 6000000 // 60 seconds
const MIN_EXECUTION_TIMEOUT_MS = 1000
const MAX_EXECUTION_TIMEOUT_MS = 60000000
const DEFAULT_REFRESH_DEBOUNCE_MS = 500

let cachedSettingsStore: Conf<Record<string, unknown>> | null | undefined

// Cached base directory
let cachedBaseDir: string | null = null

type ElectronAppLike = {
  getPath: (name: string) => string
  getAppPath: () => string
  isPackaged?: boolean
}

const electronRequire = createNodeRequire(import.meta.url)
let cachedElectronApp: ElectronAppLike | null | undefined

function getElectronApp(): ElectronAppLike | null {
  if (cachedElectronApp !== undefined) {
    return cachedElectronApp
  }

  try {
    const electronModule = electronRequire('electron') as any
    cachedElectronApp = (electronModule?.app as ElectronAppLike | undefined) || null
  } catch {
    cachedElectronApp = null
  }

  return cachedElectronApp
}

function resolveBaseDir(): string {
  if (cachedBaseDir) {
    return cachedBaseDir
  }

  // Check environment variable override first
  const envOverride = process.env.YGG_CUSTOM_TOOLS_DIRECTORY?.trim()
  if (envOverride) {
    cachedBaseDir = path.resolve(envOverride)
    return cachedBaseDir
  }

  // Use Electron's userData path when available, with fallback for non-Electron environments
  try {
    const electronApp = getElectronApp()
    if (electronApp) {
      cachedBaseDir = electronApp.getPath('userData')
      return cachedBaseDir
    }
  } catch {
    // Fall through to cwd fallback below.
  }

  cachedBaseDir = path.resolve(process.cwd(), '.ygg-chat-r', 'custom-tools-storage')
  return cachedBaseDir
}

function getCustomToolsDirectory(): string {
  return path.join(resolveBaseDir(), CUSTOM_TOOLS_DIR_NAME)
}

function getCustomToolsResourcesDirectory(): string {
  return path.join(getCustomToolsDirectory(), CUSTOM_TOOLS_RESOURCES_DIR_NAME)
}

async function ensureManagedCustomToolsDirectories(): Promise<void> {
  await fsPromises.mkdir(getCustomToolsDirectory(), { recursive: true })
  await fsPromises.mkdir(getCustomToolsResourcesDirectory(), { recursive: true })
}

async function ensureManagedCustomToolsGuideFile(): Promise<void> {
  const targetPath = path.join(getCustomToolsDirectory(), CUSTOM_TOOLS_GUIDE_FILE)

  try {
    await fsPromises.access(targetPath)
    return
  } catch {
    // File does not exist; seed it below.
  }

  const sourcePath = resolveGuideSourcePath()
  try {
    await fsPromises.access(sourcePath)
  } catch (error) {
    console.warn('[CustomToolLoader] Guide file not found at:', sourcePath, error)
    return
  }

  try {
    await fsPromises.copyFile(sourcePath, targetPath)
    console.log('[CustomToolLoader] Seeded custom tools guide at:', targetPath)
  } catch (error) {
    console.error('[CustomToolLoader] Failed to seed guide file:', error)
  }
}

export async function ensureManagedCustomToolsInitialized(): Promise<string> {
  await ensureManagedCustomToolsDirectories()
  await ensureManagedCustomToolsGuideFile()
  return getCustomToolsDirectory()
}

function getCustomToolsStatePath(): string {
  return path.join(resolveBaseDir(), CUSTOM_TOOLS_STATE_FILE)
}

function resolveGuideSourcePath(): string {
  const electronApp = getElectronApp()

  if (electronApp?.isPackaged) {
    return path.join(process.resourcesPath, CUSTOM_TOOLS_DIR_NAME, CUSTOM_TOOLS_GUIDE_FILE)
  }

  try {
    if (electronApp) {
      return path.join(electronApp.getAppPath(), CUSTOM_TOOLS_DIR_NAME, CUSTOM_TOOLS_GUIDE_FILE)
    }
  } catch {
    // Fall through to cwd fallback below.
  }

  return path.join(process.cwd(), CUSTOM_TOOLS_DIR_NAME, CUSTOM_TOOLS_GUIDE_FILE)
}

function isWithinDirectory(targetPath: string, parentPath: string): boolean {
  const relative = path.relative(parentPath, targetPath)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

function normalizeCustomToolsRelativePath(relativePath: string): string {
  return relativePath.replace(/\\/g, '/').replace(/^\/+/, '')
}

function shouldIgnoreCustomToolsEntry(name: string): boolean {
  return name === CUSTOM_TOOLS_RESOURCES_DIR_NAME
}

function shouldIgnoreCustomToolsWatchPath(relativePath: string): boolean {
  const normalized = normalizeCustomToolsRelativePath(relativePath)
  return (
    normalized === CUSTOM_TOOLS_RESOURCES_DIR_NAME ||
    normalized.startsWith(`${CUSTOM_TOOLS_RESOURCES_DIR_NAME}/`) ||
    normalized.endsWith(CUSTOM_TOOLS_GUIDE_FILE)
  )
}

function normalizeDebounce(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_REFRESH_DEBOUNCE_MS
  return Math.min(5000, Math.max(100, Math.floor(value)))
}

function clampExecutionTimeoutMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_EXECUTION_TIMEOUT_MS
  }

  return Math.max(MIN_EXECUTION_TIMEOUT_MS, Math.min(MAX_EXECUTION_TIMEOUT_MS, Math.floor(value)))
}

function getSettingsStore(): Conf<Record<string, unknown>> | null {
  if (cachedSettingsStore !== undefined) {
    return cachedSettingsStore
  }

  try {
    cachedSettingsStore = new Conf<Record<string, unknown>>({
      projectName: 'ygg-chat-r',
      configFileMode: 0o600,
    })
  } catch {
    cachedSettingsStore = null
  }

  return cachedSettingsStore
}

function getCustomToolExecutionTimeoutMs(): number {
  try {
    const settingsStore = getSettingsStore()
    const storedSettings = (settingsStore?.get(TOOL_EXECUTION_SETTINGS_STORAGE_KEY) ?? null) as {
      toolCallTimeoutMs?: unknown
    } | null

    return clampExecutionTimeoutMs(storedSettings?.toolCallTimeoutMs)
  } catch {
    return DEFAULT_EXECUTION_TIMEOUT_MS
  }
}

// Tool definition interface (matches toolDefinitions.ts pattern)
export interface CustomToolDefinition {
  name: string
  version?: string
  enabled: boolean
  description: string
  appPermissions?: {
    agent?: 'read' | 'write'
  }
  ui?: {
    entry?: string
  }
  jsRuntimeMode?: 'electron' | 'custom' | 'none'
  jsRuntimes?: string
  author?: string
  inputSchema: {
    type: 'object'
    properties: Record<string, any>
    required?: string[]
  }
  isCustom: true // Flag to distinguish from built-in
  sourcePath: string
  directoryName: string
}

export interface CustomToolLifecycleSettings {
  autoRefresh: boolean
  refreshDebounceMs: number
}

export interface CustomToolStatus {
  name: string
  enabled: boolean
  description: string
  sourcePath: string
  directoryName: string
  loaded: boolean
  loadError?: string
  lastLoadedAt?: string
}

export interface AddCustomToolOptions {
  directoryName?: string
  overwrite?: boolean
}

export interface AddCustomToolResult {
  targetPath: string
  loadedToolNames: string[]
}

export interface RemoveCustomToolResult {
  removedPath: string
  removedToolNames: string[]
}

export interface CustomToolsChangedEvent {
  reason: string
  totalCount: number
  tools: CustomToolDefinition[]
}

// Tool execution options (matches built-in tools pattern, extended with context)
export interface ToolExecutionOptions {
  cwd?: string
  operationMode?: 'plan' | 'execute'
  rootPath?: string
  conversationId?: string | null
  messageId?: string | null
  streamId?: string | null
}

export interface ToolModelImageContent {
  type: 'input_image'
  image_url: string
  detail?: 'high' | 'original'
}

/**
 * Optional split-channel result fields for tools with large/model-only payloads.
 * displayContent and persistedContent must stay compact. modelContent is ephemeral
 * provider input and must never be written to chat history, hooks, or logs.
 */
export interface SplitToolResultContent {
  displayContent?: unknown
  persistedContent?: unknown
  modelContent?: string | ToolModelImageContent[]
}

// Tool result interface
export interface ToolResult extends SplitToolResultContent {
  success: boolean
  error?: string
  [key: string]: any
}

// Tool implementation interface
export interface CustomToolImplementation {
  execute: (args: any, options: ToolExecutionOptions) => Promise<ToolResult>
  meta?: { name: string; version: string }
}

interface LoadedCustomTool {
  definition: CustomToolDefinition
  implementationPath: string
  cacheToken: string
  implementation?: CustomToolImplementation
  loadError?: string
  lastLoadedAt?: string
}

interface CustomToolsStateFile {
  settings?: {
    autoRefresh?: boolean
    refreshDebounceMs?: number
  }
  tools?: Record<string, { enabled?: boolean }>
}

// Validate tool name format (lowercase alphanumeric with underscores)
function isValidToolName(name: string): boolean {
  return /^[a-z][a-z0-9_]*$/.test(name)
}

// Validate definition structure
function validateDefinition(def: any): def is Omit<CustomToolDefinition, 'isCustom' | 'sourcePath' | 'directoryName'> {
  if (typeof def !== 'object' || def === null) return false
  if (typeof def.name !== 'string' || !isValidToolName(def.name)) return false
  if (typeof def.description !== 'string' || def.description.length === 0) return false
  if (typeof def.inputSchema !== 'object' || def.inputSchema === null) return false
  if (def.inputSchema.type !== 'object') return false
  if (typeof def.inputSchema.properties !== 'object') return false
  // enabled defaults to true if not specified
  if (def.enabled !== undefined && typeof def.enabled !== 'boolean') return false
  return true
}

type JsRuntimeMode = 'electron' | 'custom' | 'none'

function resolveRuntimeEnv(definition: CustomToolDefinition): {
  jsRuntimes?: string
  setElectronRunAsNode: boolean
} | null {
  const mode: JsRuntimeMode = definition.jsRuntimeMode || 'electron'

  if (mode === 'none') return null
  if (mode === 'custom') {
    const jsRuntimes = definition.jsRuntimes?.trim()
    if (!jsRuntimes) return null
    return { jsRuntimes, setElectronRunAsNode: false }
  }

  return { jsRuntimes: `node:${process.execPath}`, setElectronRunAsNode: true }
}

function snapshotEnv(key: string): { hasKey: boolean; value?: string } {
  const hasKey = Object.prototype.hasOwnProperty.call(process.env, key)
  return { hasKey, value: hasKey ? process.env[key] : undefined }
}

function restoreEnv(key: string, snapshot: { hasKey: boolean; value?: string }): void {
  if (snapshot.hasKey && snapshot.value !== undefined) {
    process.env[key] = snapshot.value
    return
  }

  delete process.env[key]
}

function cloneDefinition(definition: CustomToolDefinition): CustomToolDefinition {
  return {
    ...definition,
    inputSchema: {
      ...definition.inputSchema,
      properties: { ...definition.inputSchema.properties },
      required: definition.inputSchema.required ? [...definition.inputSchema.required] : undefined,
    },
    appPermissions: definition.appPermissions ? { ...definition.appPermissions } : undefined,
    ui: definition.ui ? { ...definition.ui } : undefined,
  }
}

/**
 * Custom Tool Registry
 * Manages loading, storing, and executing user-defined custom tools
 */
class CustomToolRegistry extends EventEmitter {
  private tools: Map<string, LoadedCustomTool> = new Map()
  private initialized: boolean = false
  private initPromise: Promise<void> | null = null
  private reloadPromise: Promise<void> | null = null
  private stateOverrides: Map<string, boolean> = new Map()
  private settings: CustomToolLifecycleSettings = {
    autoRefresh: true,
    refreshDebounceMs: DEFAULT_REFRESH_DEBOUNCE_MS,
  }
  private reloadGeneration = 0

  private watcherMode: 'none' | 'recursive' | 'shallow' = 'none'
  private rootWatcher: FSWatcher | null = null
  private stateWatcher: FSWatcher | null = null
  private toolWatchers: Map<string, FSWatcher> = new Map()
  private watcherDebounceTimer: NodeJS.Timeout | null = null

  /**
   * Initialize the registry by scanning the custom tools directory
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      this.updateWatchers()
      return
    }
    if (this.initPromise) return this.initPromise

    this.initPromise = this._doInitialize()
    await this.initPromise
    this.initPromise = null
  }

  private async _doInitialize(): Promise<void> {
    const customToolsDir = getCustomToolsDirectory()
    console.log('[CustomToolLoader] Initializing custom tools from:', customToolsDir)

    await ensureManagedCustomToolsInitialized()
    await this.loadStateFile()
    await this.loadAllTools(this.tools)
    this.updateWatchers()
    this.initialized = true
  }

  private async loadStateFile(): Promise<void> {
    const statePath = getCustomToolsStatePath()
    let parsed: CustomToolsStateFile = {}

    try {
      const content = await fsPromises.readFile(statePath, 'utf-8')
      parsed = JSON.parse(content) as CustomToolsStateFile
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('[CustomToolLoader] Failed to read state file:', error)
      }
    }

    this.settings = {
      autoRefresh: parsed.settings?.autoRefresh !== false,
      refreshDebounceMs: normalizeDebounce(parsed.settings?.refreshDebounceMs),
    }

    this.stateOverrides.clear()
    const toolEntries = parsed.tools || {}
    for (const [toolName, toolState] of Object.entries(toolEntries)) {
      if (typeof toolState?.enabled === 'boolean') {
        this.stateOverrides.set(toolName, toolState.enabled)
      }
    }
  }

  private async saveStateFile(): Promise<void> {
    const statePath = getCustomToolsStatePath()
    await fsPromises.mkdir(path.dirname(statePath), { recursive: true })

    const tools: Record<string, { enabled: boolean }> = {}
    for (const [toolName, enabled] of Array.from(this.stateOverrides.entries()).sort((a, b) =>
      a[0].localeCompare(b[0])
    )) {
      tools[toolName] = { enabled }
    }

    const payload: CustomToolsStateFile = {
      settings: {
        autoRefresh: this.settings.autoRefresh,
        refreshDebounceMs: this.settings.refreshDebounceMs,
      },
      tools,
    }

    await fsPromises.writeFile(statePath, JSON.stringify(payload, null, 2), 'utf-8')
  }

  /**
   * Load all tools from the custom tools directory.
   * Note: implementations are lazy-loaded on first execution.
   */
  private async loadAllTools(previousTools: Map<string, LoadedCustomTool>): Promise<void> {
    const nextTools: Map<string, LoadedCustomTool> = new Map()
    const dir = getCustomToolsDirectory()

    try {
      const entries = await fsPromises.readdir(dir, { withFileTypes: true })
      const toolEntries = entries.filter(entry => entry.isDirectory() && !shouldIgnoreCustomToolsEntry(entry.name))
      await Promise.all(toolEntries.map(entry => this.loadTool(entry.name, nextTools, previousTools)))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('[CustomToolLoader] Error scanning tools directory:', error)
      }
    }

    this.tools = nextTools
  }

  /**
   * Load a single tool's definition from its directory.
   */
  private async loadTool(
    toolDirName: string,
    nextTools: Map<string, LoadedCustomTool>,
    previousTools: Map<string, LoadedCustomTool>
  ): Promise<void> {
    const toolPath = path.join(getCustomToolsDirectory(), toolDirName)
    const definitionPath = path.join(toolPath, DEFINITION_FILE)
    const implementationPath = path.join(toolPath, IMPLEMENTATION_FILE)

    try {
      // Check both files exist
      await fsPromises.access(definitionPath)
      await fsPromises.access(implementationPath)

      // Load and parse definition
      const definitionRaw = await fsPromises.readFile(definitionPath, 'utf-8')
      let definition: any
      try {
        definition = JSON.parse(definitionRaw)
      } catch (parseError) {
        console.warn(`[CustomToolLoader] Invalid JSON in ${toolDirName}/definition.json:`, parseError)
        return
      }

      // Validate definition schema
      if (!validateDefinition(definition)) {
        console.warn(
          `[CustomToolLoader] Invalid definition for ${toolDirName}: ` +
            'Must have name (lowercase with underscores), description, and inputSchema with type "object"'
        )
        return
      }

      // Check for name collision with directory name
      if (definition.name !== toolDirName && definition.name !== toolDirName.replace(/-/g, '_')) {
        console.warn(
          `[CustomToolLoader] Tool name "${definition.name}" doesn't match directory "${toolDirName}". ` +
            'Consider renaming for consistency.'
        )
      }

      if (nextTools.has(definition.name)) {
        console.warn(`[CustomToolLoader] Duplicate tool name "${definition.name}" detected. Later entry ignored.`)
        return
      }

      const implementationStat = await fsPromises.stat(implementationPath)
      const cacheToken = `${implementationStat.mtimeMs}:${implementationStat.size}:${this.reloadGeneration}`
      const previous = previousTools.get(definition.name)
      const canReuseImplementation =
        previous &&
        previous.definition.sourcePath === toolPath &&
        previous.implementationPath === implementationPath &&
        previous.cacheToken === cacheToken

      const enabled = this.stateOverrides.has(definition.name)
        ? this.stateOverrides.get(definition.name)!
        : definition.enabled !== false

      const customDefinition: CustomToolDefinition = {
        name: definition.name,
        version: definition.version,
        enabled,
        description: definition.description,
        appPermissions: definition.appPermissions,
        ui: definition.ui,
        jsRuntimeMode: definition.jsRuntimeMode,
        jsRuntimes: definition.jsRuntimes,
        author: definition.author,
        inputSchema: definition.inputSchema,
        isCustom: true,
        sourcePath: toolPath,
        directoryName: toolDirName,
      }

      nextTools.set(definition.name, {
        definition: customDefinition,
        implementationPath,
        cacheToken,
        implementation: canReuseImplementation ? previous?.implementation : undefined,
        loadError: canReuseImplementation ? previous?.loadError : undefined,
        lastLoadedAt: canReuseImplementation ? previous?.lastLoadedAt : undefined,
      })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        console.warn(
          `[CustomToolLoader] Tool ${toolDirName} missing required files (${DEFINITION_FILE} and/or ${IMPLEMENTATION_FILE})`
        )
      } else {
        console.warn(`[CustomToolLoader] Failed to load tool ${toolDirName}:`, error)
      }
    }
  }

  private async loadImplementation(tool: LoadedCustomTool): Promise<CustomToolImplementation> {
    if (tool.implementation) {
      return tool.implementation
    }

    const implementationUrl = `${pathToFileURL(tool.implementationPath).href}?v=${encodeURIComponent(tool.cacheToken)}`
    let implementationModule: any
    try {
      implementationModule = await import(implementationUrl)
    } catch (importError) {
      tool.loadError = importError instanceof Error ? importError.message : String(importError)
      throw new Error(`Failed to import ${tool.definition.name}: ${tool.loadError}`)
    }

    if (typeof implementationModule.execute !== 'function') {
      tool.loadError = `Missing or invalid 'execute' function in ${tool.definition.directoryName}/${IMPLEMENTATION_FILE}`
      throw new Error(tool.loadError)
    }

    tool.implementation = implementationModule as CustomToolImplementation
    tool.loadError = undefined
    tool.lastLoadedAt = new Date().toISOString()
    return tool.implementation
  }

  private scheduleWatcherReload(trigger: string): void {
    if (!this.settings.autoRefresh) return
    if (this.watcherDebounceTimer) {
      clearTimeout(this.watcherDebounceTimer)
    }

    this.watcherDebounceTimer = setTimeout(() => {
      this.watcherDebounceTimer = null
      this.reload(`watch:${trigger}`).catch(error => {
        console.error('[CustomToolLoader] Auto-refresh reload failed:', error)
      })
    }, this.settings.refreshDebounceMs)
  }

  private closeToolWatchers(): void {
    for (const watcher of this.toolWatchers.values()) {
      watcher.close()
    }
    this.toolWatchers.clear()
  }

  private startStateWatcher(): void {
    if (this.stateWatcher || !this.settings.autoRefresh) return

    const statePath = getCustomToolsStatePath()
    const stateDir = path.dirname(statePath)

    try {
      this.stateWatcher = fs.watch(stateDir, (_event, filename) => {
        const name = typeof filename === 'string' ? filename : ''
        if (!name) return
        if (path.basename(name) !== CUSTOM_TOOLS_STATE_FILE) return
        this.scheduleWatcherReload('state')
      })

      this.stateWatcher.on('error', error => {
        console.warn('[CustomToolLoader] State watcher error:', error)
        this.scheduleWatcherReload('state_error')
      })
    } catch (error) {
      console.warn('[CustomToolLoader] Failed to watch state file directory:', error)
    }
  }

  private stopStateWatcher(): void {
    if (!this.stateWatcher) return
    this.stateWatcher.close()
    this.stateWatcher = null
  }

  private syncToolWatchers(): void {
    if (this.watcherMode !== 'shallow') {
      this.closeToolWatchers()
      return
    }

    const toolDirs = new Set(Array.from(this.tools.values()).map(tool => tool.definition.sourcePath))

    for (const [dirPath, watcher] of this.toolWatchers.entries()) {
      if (!toolDirs.has(dirPath)) {
        watcher.close()
        this.toolWatchers.delete(dirPath)
      }
    }

    for (const dirPath of toolDirs) {
      if (this.toolWatchers.has(dirPath)) continue
      try {
        const watcher = fs.watch(dirPath, { recursive: true }, () => this.scheduleWatcherReload('tool'))
        watcher.on('error', error => {
          console.warn(`[CustomToolLoader] Tool watcher error (${dirPath}):`, error)
          this.scheduleWatcherReload('tool_error')
        })
        this.toolWatchers.set(dirPath, watcher)
      } catch {
        try {
          const watcher = fs.watch(dirPath, () => this.scheduleWatcherReload('tool'))
          watcher.on('error', error => {
            console.warn(`[CustomToolLoader] Tool watcher error (${dirPath}):`, error)
            this.scheduleWatcherReload('tool_error')
          })
          this.toolWatchers.set(dirPath, watcher)
        } catch (error) {
          console.warn(`[CustomToolLoader] Failed to watch tool directory (${dirPath}):`, error)
        }
      }
    }
  }

  private startWatcher(): void {
    if (this.rootWatcher || !this.settings.autoRefresh) return

    this.startStateWatcher()

    const dir = getCustomToolsDirectory()
    try {
      this.rootWatcher = fs.watch(dir, { recursive: true }, (_event, filename) => {
        const name = typeof filename === 'string' ? filename : ''
        if (name && shouldIgnoreCustomToolsWatchPath(name)) return
        this.scheduleWatcherReload('root_recursive')
      })
      this.watcherMode = 'recursive'
      console.log('[CustomToolLoader] Auto-refresh watcher enabled (recursive)')
    } catch {
      this.rootWatcher = fs.watch(dir, (_event, filename) => {
        const name = typeof filename === 'string' ? filename : ''
        if (name && shouldIgnoreCustomToolsWatchPath(name)) return
        this.scheduleWatcherReload('root')
      })
      this.watcherMode = 'shallow'
      this.syncToolWatchers()
      console.log('[CustomToolLoader] Auto-refresh watcher enabled (root + per-tool)')
    }

    this.rootWatcher.on('error', error => {
      console.warn('[CustomToolLoader] Root watcher error:', error)
      this.scheduleWatcherReload('root_error')
    })
  }

  private stopWatcher(): void {
    if (this.watcherDebounceTimer) {
      clearTimeout(this.watcherDebounceTimer)
      this.watcherDebounceTimer = null
    }
    if (this.rootWatcher) {
      this.rootWatcher.close()
      this.rootWatcher = null
    }
    this.stopStateWatcher()
    this.closeToolWatchers()
    this.watcherMode = 'none'
  }

  private updateWatchers(): void {
    if (!this.settings.autoRefresh) {
      this.stopWatcher()
      return
    }

    if (!this.rootWatcher) {
      this.startWatcher()
    } else {
      this.startStateWatcher()
      this.syncToolWatchers()
    }
  }

  private emitToolsChanged(reason: string): void {
    const tools = this.getDefinitions()
    const payload: CustomToolsChangedEvent = {
      reason,
      totalCount: tools.length,
      tools,
    }
    this.emit('toolsChanged', payload)
  }

  /**
   * Get all custom tool definitions
   */
  getDefinitions(): CustomToolDefinition[] {
    return Array.from(this.tools.values())
      .map(tool => cloneDefinition(tool.definition))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  getStatuses(): CustomToolStatus[] {
    return Array.from(this.tools.values())
      .map(tool => ({
        name: tool.definition.name,
        enabled: tool.definition.enabled,
        description: tool.definition.description,
        sourcePath: tool.definition.sourcePath,
        directoryName: tool.definition.directoryName,
        loaded: Boolean(tool.implementation),
        loadError: tool.loadError,
        lastLoadedAt: tool.lastLoadedAt,
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  /**
   * Check if a custom tool exists
   */
  hasCustomTool(name: string): boolean {
    return this.tools.has(name)
  }

  /**
   * Execute a custom tool with lazy loading and timeout protection
   */
  async executeTool(name: string, args: any, options: ToolExecutionOptions): Promise<ToolResult> {
    const tool = this.tools.get(name)
    if (!tool) {
      return { success: false, error: `Custom tool '${name}' not found` }
    }

    // Check if tool is enabled
    if (!tool.definition.enabled) {
      return { success: false, error: `Custom tool '${name}' is disabled` }
    }

    let implementation: CustomToolImplementation
    try {
      implementation = await this.loadImplementation(tool)
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }

    const envPatch = resolveRuntimeEnv(tool.definition)
    const prevJsRuntimes = snapshotEnv('YT_DLP_JS_RUNTIMES')
    const prevElectronRunAsNode = snapshotEnv('ELECTRON_RUN_AS_NODE')

    if (envPatch) {
      if (envPatch.jsRuntimes) {
        process.env.YT_DLP_JS_RUNTIMES = envPatch.jsRuntimes
      }
      if (envPatch.setElectronRunAsNode) {
        process.env.ELECTRON_RUN_AS_NODE = '1'
      }
    }

    try {
      const executionTimeoutMs = getCustomToolExecutionTimeoutMs()

      // Execute with timeout
      const result = await Promise.race([
        implementation.execute(args, options),
        new Promise<ToolResult>((_, reject) =>
          setTimeout(
            () => reject(new Error(`Tool execution timed out after ${executionTimeoutMs}ms`)),
            executionTimeoutMs
          )
        ),
      ])

      return result
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }
    } finally {
      restoreEnv('YT_DLP_JS_RUNTIMES', prevJsRuntimes)
      restoreEnv('ELECTRON_RUN_AS_NODE', prevElectronRunAsNode)
    }
  }

  /**
   * Reload all custom tool definitions from disk.
   */
  async reload(reason: string = 'manual'): Promise<void> {
    await this.initialize()
    if (this.reloadPromise) {
      return this.reloadPromise
    }

    this.reloadPromise = (async () => {
      this.reloadGeneration += 1
      const previousTools = this.tools
      await this.loadStateFile()
      await this.loadAllTools(previousTools)
      this.updateWatchers()
      this.emitToolsChanged(reason)
    })().finally(() => {
      this.reloadPromise = null
    })

    return this.reloadPromise
  }

  /**
   * Enable or disable a tool without editing definition.json.
   */
  async setToolEnabled(name: string, enabled: boolean): Promise<CustomToolDefinition | null> {
    await this.initialize()
    const tool = this.tools.get(name)
    if (!tool) {
      return null
    }

    tool.definition.enabled = enabled
    this.stateOverrides.set(name, enabled)
    await this.saveStateFile()
    this.emitToolsChanged(enabled ? 'enable' : 'disable')
    return cloneDefinition(tool.definition)
  }

  getSettings(): CustomToolLifecycleSettings {
    return { ...this.settings }
  }

  async updateSettings(updates: Partial<CustomToolLifecycleSettings>): Promise<CustomToolLifecycleSettings> {
    await this.initialize()

    if (updates.autoRefresh !== undefined) {
      this.settings.autoRefresh = Boolean(updates.autoRefresh)
    }
    if (updates.refreshDebounceMs !== undefined) {
      this.settings.refreshDebounceMs = normalizeDebounce(updates.refreshDebounceMs)
    }

    await this.saveStateFile()
    this.updateWatchers()
    this.emitToolsChanged('settings')
    return this.getSettings()
  }

  /**
   * Copy a tool folder into the managed custom-tools directory.
   */
  async addToolFromDirectory(sourcePath: string, options: AddCustomToolOptions = {}): Promise<AddCustomToolResult> {
    await this.initialize()
    const resolvedSource = path.resolve(sourcePath)
    const sourceStat = await fsPromises.stat(resolvedSource)
    if (!sourceStat.isDirectory()) {
      throw new Error('sourcePath must be a directory')
    }

    const directoryNameRaw = (options.directoryName || path.basename(resolvedSource)).trim()
    if (!directoryNameRaw) {
      throw new Error('directoryName resolved to empty string')
    }
    if (directoryNameRaw.includes('/') || directoryNameRaw.includes('\\')) {
      throw new Error('directoryName must not contain path separators')
    }

    const toolsDir = getCustomToolsDirectory()
    const targetPath = path.join(toolsDir, directoryNameRaw)
    if (!isWithinDirectory(targetPath, toolsDir)) {
      throw new Error('Resolved target directory is outside of custom tools directory')
    }

    const overwrite = options.overwrite === true
    try {
      await fsPromises.access(targetPath)
      if (!overwrite) {
        throw new Error(`Target directory already exists: ${targetPath}`)
      }
      await fsPromises.rm(targetPath, { recursive: true, force: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
    }

    await fsPromises.cp(resolvedSource, targetPath, { recursive: true })
    await this.reload('add')

    const loadedToolNames = this.getDefinitions()
      .filter(def => path.resolve(def.sourcePath) === path.resolve(targetPath))
      .map(def => def.name)

    return {
      targetPath,
      loadedToolNames,
    }
  }

  /**
   * Remove a tool by tool name (preferred) or directory name.
   */
  async removeTool(nameOrDirectory: string): Promise<RemoveCustomToolResult> {
    await this.initialize()

    const toolsDir = getCustomToolsDirectory()
    const toolByName = this.tools.get(nameOrDirectory)
    const targetPath = toolByName ? toolByName.definition.sourcePath : path.join(toolsDir, nameOrDirectory)

    if (!isWithinDirectory(path.resolve(targetPath), path.resolve(toolsDir))) {
      throw new Error('Resolved target directory is outside of custom tools directory')
    }

    const removedToolNames = Array.from(this.tools.values())
      .filter(tool => path.resolve(tool.definition.sourcePath) === path.resolve(targetPath))
      .map(tool => tool.definition.name)

    const targetStat = await fsPromises.stat(targetPath)
    if (!targetStat.isDirectory()) {
      throw new Error('Target to remove must be a directory')
    }

    await fsPromises.rm(targetPath, { recursive: true, force: true })

    for (const toolName of removedToolNames) {
      this.stateOverrides.delete(toolName)
    }
    await this.saveStateFile()
    await this.reload('remove')

    return {
      removedPath: targetPath,
      removedToolNames,
    }
  }

  /**
   * Get the custom tools directory path
   */
  getCustomToolsDirectoryPath(): string {
    return getCustomToolsDirectory()
  }

  /**
   * Get count of loaded tool definitions.
   */
  getToolCount(): number {
    return this.tools.size
  }

  /**
   * Stop file watchers (used during app shutdown).
   */
  shutdown(): void {
    this.stopWatcher()
  }
}

// Singleton instance
export const customToolRegistry = new CustomToolRegistry()
