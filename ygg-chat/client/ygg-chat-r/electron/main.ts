import Conf from 'conf'
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, screen, shell, Tray, webContents } from 'electron'
import autoUpdaterPkg from 'electron-updater'
import fs from 'fs'
import { randomBytes } from 'crypto'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import './envLoader.js'
import {
  deleteBraveApiKey,
  getBraveApiKey,
  hasBraveApiKey,
  setBraveApiKey,
} from './keytarSecrets.js'
import { ensureManagedHooksInitialized } from './hooks/hookStorage.js'
import { startLocalServer, stopLocalServer } from './localServer.js'
import { ensureManagedCustomToolsInitialized } from './tools/customToolLoader.js'
import { ensureManagedThemesInitialized } from './tools/themeManager.js'
import { detectPathType, getWSLCommandArgs, isWindows } from './utils/wslBridge.js'
import { OpenAiChatgptProvider } from './headlessServer/providers/openaiChatgptProvider.js'
import { getValidTokens, clearTokens as clearOpenAIStoredTokens, fetchOpenAIUsageStatus } from './openaiChatgptOAuth.js'

// Destructure autoUpdater from CommonJS module (ESM/CJS interop)
const { autoUpdater } = autoUpdaterPkg

// ESM: Get __dirname from import.meta.url
const __dirname = fileURLToPath(new URL('.', import.meta.url))
let mainWindow: BrowserWindow | null = null
let floatingWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false
let compactMode = false
let savedBounds: Electron.Rectangle | null = null
let localServerStarted = false
let localServerPort: number | null = null
let localServerUrl: string | null = null
let localServerLanUrl: string | null = null
let localServerError: string | null = null

const LOCAL_SERVER_PREFERRED_PORT = 3002
const LOCAL_SERVER_FALLBACK_PORTS = Array.from({ length: 13 }, (_, index) => LOCAL_SERVER_PREFERRED_PORT + 1 + index)
const localServerAllowRemoteEnvRaw = (process.env.YGG_LOCAL_SERVER_ALLOW_REMOTE || '').trim().toLowerCase()
const LOCAL_SERVER_ALLOW_REMOTE =
  localServerAllowRemoteEnvRaw.length > 0
    ? ['1', 'true', 'yes', 'on'].includes(localServerAllowRemoteEnvRaw)
    : process.platform === 'win32'
const LOCAL_SERVER_HOST =
  process.env.YGG_LOCAL_SERVER_HOST?.trim() || (LOCAL_SERVER_ALLOW_REMOTE ? '0.0.0.0' : '127.0.0.1')
const LOCAL_SERVER_ADVERTISE_HOST =
  process.env.YGG_LOCAL_SERVER_ADVERTISE_HOST?.trim() ||
  (LOCAL_SERVER_HOST === '0.0.0.0' ? '127.0.0.1' : LOCAL_SERVER_HOST)
const LOCAL_SERVER_LAN_ADVERTISE_HOST = process.env.YGG_LOCAL_SERVER_LAN_ADVERTISE_HOST?.trim() || ''
const LOCAL_SERVER_ALLOW_EPHEMERAL_PORT = true
const BROWSER_SETTINGS_STORAGE_KEY = 'ygg_browser_settings'
const DEFAULT_GUEST_DEVTOOLS_ENABLED = true

if (!process.env.YGG_HERMES_MCP_AUTH_TOKEN?.trim()) {
  process.env.YGG_HERMES_MCP_AUTH_TOKEN = randomBytes(32).toString('hex')
}

function isPrivateIpv4(address: string): boolean {
  if (address.startsWith('10.')) return true
  if (address.startsWith('192.168.')) return true
  if (!address.startsWith('172.')) return false
  const secondOctet = Number(address.split('.')[1])
  return Number.isInteger(secondOctet) && secondOctet >= 16 && secondOctet <= 31
}

function detectPreferredLanIpv4(): string | null {
  if (LOCAL_SERVER_LAN_ADVERTISE_HOST) {
    return LOCAL_SERVER_LAN_ADVERTISE_HOST
  }

  const interfaces = os.networkInterfaces()
  const candidates: string[] = []

  for (const entries of Object.values(interfaces)) {
    if (!entries) continue
    for (const entry of entries) {
      if (!entry || entry.family !== 'IPv4' || entry.internal) continue
      candidates.push(entry.address)
    }
  }

  if (candidates.length === 0) return null

  const privateCandidate = candidates.find(isPrivateIpv4)
  return privateCandidate || candidates[0] || null
}
const activeReadStreams = new Map<
  string,
  {
    stream: fs.ReadStream
    sender: Electron.WebContents
    loaded: number
    total: number | null
    aborted: boolean
    abortedSent: boolean
  }
>()

type TerminalSessionRecord = {
  sessionId: string
  pty: import('node-pty').IPty
  sender: Electron.WebContents
  cwd: string
  shell: string
  cols: number
  rows: number
}

const activeTerminalSessions = new Map<string, TerminalSessionRecord>()

function getNodePtyModule(): typeof import('node-pty') {
  return require('node-pty') as typeof import('node-pty')
}

function makeTerminalSessionId(): string {
  return `terminal_${Date.now()}_${Math.random().toString(16).slice(2)}`
}

function clampTerminalDimension(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.floor(value as number)))
}

function normalizeTerminalCwd(inputCwd?: string): string {
  const trimmed = inputCwd?.trim()
  if (!trimmed) {
    return process.cwd()
  }

  if (!isWindows()) {
    return path.isAbsolute(trimmed) ? trimmed : path.resolve(trimmed)
  }

  const pathType = detectPathType(trimmed)
  if (pathType === 'linux') {
    return trimmed
  }
  if (pathType === 'windows') {
    return path.win32.normalize(trimmed)
  }
  return path.win32.resolve(trimmed)
}

async function resolveTerminalLaunch(inputCwd?: string): Promise<{
  file: string
  args: string[]
  spawnCwd: string
  displayCwd: string
  shellLabel: string
}> {
  const normalizedCwd = normalizeTerminalCwd(inputCwd)

  if (!isWindows()) {
    const shellPath = process.env.SHELL?.trim() || '/bin/bash'
    return {
      file: shellPath,
      args: ['-i'],
      spawnCwd: normalizedCwd,
      displayCwd: normalizedCwd,
      shellLabel: path.posix.basename(shellPath) || shellPath,
    }
  }

  if (detectPathType(normalizedCwd) === 'linux') {
    const [file, args] = await getWSLCommandArgs('bash', ['-i'], normalizedCwd)
    return {
      file,
      args,
      spawnCwd: process.cwd(),
      displayCwd: normalizedCwd,
      shellLabel: 'wsl bash',
    }
  }

  const configuredShell = process.env.YGG_TERMINAL_SHELL?.trim()
  const shellPath = configuredShell || 'powershell.exe'
  const shellBaseName = path.win32.basename(shellPath).toLowerCase()
  const args = shellBaseName === 'powershell.exe' || shellBaseName === 'pwsh.exe' ? ['-NoLogo'] : []

  return {
    file: shellPath,
    args,
    spawnCwd: normalizedCwd,
    displayCwd: normalizedCwd,
    shellLabel: path.win32.basename(shellPath) || shellPath,
  }
}

function sendTerminalEvent(sender: Electron.WebContents, channel: string, payload: Record<string, any>): void {
  if (!sender.isDestroyed()) {
    sender.send(channel, payload)
  }
}

function destroyTerminalSession(sessionId: string): boolean {
  const session = activeTerminalSessions.get(sessionId)
  if (!session) return false
  activeTerminalSessions.delete(sessionId)
  try {
    session.pty.kill()
  } catch (error) {
    console.warn('[Electron Terminal] Failed to kill session:', error)
  }
  return true
}

function cleanupTerminalSessionsForSender(sender: Electron.WebContents): void {
  const ownedSessionIds: string[] = []

  for (const [sessionId, session] of activeTerminalSessions.entries()) {
    if (session.sender.id === sender.id) {
      ownedSessionIds.push(sessionId)
    }
  }

  for (const sessionId of ownedSessionIds) {
    destroyTerminalSession(sessionId)
  }
}

// Custom protocol for OAuth callbacks
const PROTOCOL = 'yggchat'
const UPDATE_FEED_BASE_URL =
  process.env.SUPABASE_UPDATE_FEED_BASE_URL || 'https://auth.yggchat.com/storage/v1/object/public/updates/updates'
const CLIENT_ERROR_LOG_FILENAME = 'client-errors.ndjson'
let autoUpdaterConfigured = false

function getClientErrorLogPath(): string {
  const logsDir = path.join(app.getPath('userData'), 'logs')
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true })
  }
  return path.join(logsDir, CLIENT_ERROR_LOG_FILENAME)
}

const TRUTHY_ENV_VALUES = new Set(['1', 'true', 'yes', 'on'])
const HERMES_RUNTIME_SETTINGS_STORAGE_KEY = 'ygg_hermes_runtime_settings'

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) return false
  return TRUTHY_ENV_VALUES.has(value.trim().toLowerCase())
}

function isEnvDevMode(): boolean {
  const nodeEnv = (process.env.NODE_ENV || '').trim().toLowerCase()
  if (nodeEnv === 'development' || nodeEnv === 'dev') {
    return true
  }

  return isTruthyEnv(process.env.DEBUG) || isTruthyEnv(process.env.ELECTRON_DEVTOOLS)
}

const isNpmElectronRun = (process.env.npm_lifecycle_event || '').trim().toLowerCase() === 'electron'
const hasDebugModeArg = process.argv.includes('--debug-mode')
const isDebugMode = isEnvDevMode() || isNpmElectronRun || hasDebugModeArg
const shouldOpenDetachedDevTools = isDebugMode

// Set App User Model ID for Windows taskbar icon
if (process.platform === 'win32') {
  app.setAppUserModelId('com.graviton.chat')
}

// Use system theme by default for native UI (context menus, dialogs, mica material).
// Renderer can override this via ipc "theme:update".
nativeTheme.themeSource = 'system'


// Persistent storage for session data (initialized async)
let store: any = null
let storeInitialized = false

// In-memory fallback storage
const memoryStore = new Map<string, any>()

// Initialize conf (ESM module)
async function initializeStore() {
  try {
    const configDir = path.join(os.homedir(), '.config', 'ygg-chat-r')
    const configFile = path.join(configDir, 'config.json')

    // Check if config file exists and is corrupted
    if (fs.existsSync(configFile)) {
      try {
        const content = fs.readFileSync(configFile, 'utf-8')
        // Try to parse to validate JSON
        JSON.parse(content)
      } catch (parseError) {
        console.warn('[Electron] Config file corrupted, removing:', configFile)
        try {
          fs.unlinkSync(configFile)
        } catch (unlinkError) {
          console.warn('[Electron] Failed to remove corrupted config file:', unlinkError)
        }
      }
    }

    // Initialize conf (ESM library)
    store = new Conf({
      projectName: 'ygg-chat-r',
      configFileMode: 0o600,
    })
    storeInitialized = true
    console.log('[Electron] Storage initialized successfully (conf)')
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    const errorStack = error instanceof Error ? error.stack : ''
    console.error('[Electron] Failed to initialize conf storage')
    console.error('[Electron] Error message:', errorMsg)
    console.error('[Electron] Error stack:', errorStack)
    console.warn('[Electron] ⚠️  Using in-memory fallback storage')
    console.warn('[Electron] Note: Data will not persist after app restart')
    storeInitialized = true // Mark as initialized even with fallback
  }
}

// Helper functions for storage access with fallback
function getFromStore(key: string): any {
  if (!storeInitialized) {
    console.warn('[Electron] Store not yet initialized')
    return null
  }

  try {
    if (store) {
      return store.get(key)
    } else {
      // Use in-memory fallback
      return memoryStore.get(key) || null
    }
  } catch (error) {
    console.error('[Electron] Error reading from store:', error)
    return memoryStore.get(key) || null
  }
}

function setInStore(key: string, value: any): boolean {
  if (!storeInitialized) {
    console.warn('[Electron] Store not yet initialized')
    return false
  }

  try {
    if (store) {
      store.set(key, value)
      return true
    } else {
      // Use in-memory fallback
      memoryStore.set(key, value)
      return true
    }
  } catch (error) {
    console.error('[Electron] Error writing to store:', error)
    // Fallback to memory
    memoryStore.set(key, value)
    return false
  }
}

function deleteFromStore(key: string): boolean {
  if (!storeInitialized) {
    console.warn('[Electron] Store not yet initialized')
    return false
  }

  try {
    if (store) {
      store.delete(key)
      return true
    } else {
      memoryStore.delete(key)
      return true
    }
  } catch (error) {
    console.error('[Electron] Error deleting from store:', error)
    memoryStore.delete(key)
    return false
  }
}
function clearStore(): boolean {
  if (!storeInitialized) {
    console.warn('[Electron] Store not yet initialized')
    return false
  }

  try {
    if (store) {
      store.clear()
      return true
    } else {
      memoryStore.clear()
      return true
    }
  } catch (error) {
    console.error('[Electron] Error clearing storage:', error)
    memoryStore.clear()
    return false
  }
}

function isGuestBrowserDevToolsEnabled(): boolean {
  if (!storeInitialized) {
    return DEFAULT_GUEST_DEVTOOLS_ENABLED
  }

  try {
    const storedSettings = getFromStore(BROWSER_SETTINGS_STORAGE_KEY)
    if (storedSettings && typeof storedSettings === 'object' && typeof storedSettings.guestDevToolsEnabled === 'boolean') {
      return storedSettings.guestDevToolsEnabled
    }
  } catch (error) {
    console.error('[Electron] Failed to read browser settings from storage:', error)
  }

  return DEFAULT_GUEST_DEVTOOLS_ENABLED
}

function applyHermesRuntimeSettingsToEnv(rawSettings: any): void {

  const launchMode =
    rawSettings?.launchMode === 'native' || rawSettings?.launchMode === 'wsl' || rawSettings?.launchMode === 'auto'
      ? rawSettings.launchMode
      : 'auto'
  const wslDistro = typeof rawSettings?.wslDistro === 'string' ? rawSettings.wslDistro.trim() : ''

  process.env.HERMES_LAUNCH_MODE = launchMode

  if (wslDistro) {
    process.env.HERMES_WSL_DISTRO = wslDistro
  } else {
    delete process.env.HERMES_WSL_DISTRO
  }

  if (launchMode === 'wsl') {
    process.env.HERMES_USE_WSL = 'true'
  } else {
    delete process.env.HERMES_USE_WSL
  }
}

function syncHermesRuntimeSettingsFromStore(): void {
  try {
    const storedSettings = getFromStore(HERMES_RUNTIME_SETTINGS_STORAGE_KEY)
    if (!storedSettings || typeof storedSettings !== 'object') {
      return
    }
    applyHermesRuntimeSettingsToEnv(storedSettings)
  } catch (error) {
    console.error('[Electron] Failed to sync Hermes runtime settings from storage:', error)
  }
}

function syncLmStudioBaseUrlFromStore(): void {
  try {
    const providerSettings = getFromStore('ygg_provider_settings')
    const rawValue = typeof providerSettings?.lmStudioBaseUrl === 'string' ? providerSettings.lmStudioBaseUrl.trim() : ''
    if (rawValue) {
      const normalized = rawValue.replace(/\/+$/, '').replace(/\/v1$/i, '')
      process.env.LMSTUDIO_BASE_URL = `${normalized}/v1`
      return
    }
  } catch (error) {
    console.error('[Electron] Failed to sync LM Studio base URL from storage:', error)
  }

  delete process.env.LMSTUDIO_BASE_URL
}

// Helper to get icon path

function getIconPath(_isDark?: boolean) {
  const logoFile = process.platform === 'win32' ? 'graviton-dark1.ico' : 'graviton-dark.png'
  const iconBasePath = app.isPackaged ? path.join(__dirname, '../dist-electron/img') : path.join(__dirname, '../public/img')
  const preferredIconPath = path.join(iconBasePath, logoFile)

  if (process.platform === 'win32' && !fs.existsSync(preferredIconPath)) {
    return path.join(iconBasePath, 'graviton-dark.png')
  }

  return preferredIconPath
}

// function applyTitleBarTheme(win: BrowserWindow, isDark?: boolean) {
//   // Only apply overlay on Windows where it's supported and requested, AND ONLY IN PRODUCTION
//   if (process.platform === 'win32' && app.isPackaged) {
//     // Use provided isDark value, or fall back to system preference
//     const useDark = isDark !== undefined ? isDark : nativeTheme.shouldUseDarkColors
//     win.setTitleBarOverlay({
//       color: 'transparent',
//       symbolColor: useDark ? '#f2f4f7' : '#0f172a',
//       height: 35, // Ensure there is a grippable area
//     })
//   }

//   // Update Window Icon
//   const useDark = isDark !== undefined ? isDark : nativeTheme.shouldUseDarkColors
//   win.setIcon(getIconPath(useDark))
// }

// nativeTheme.on('updated', () => {
//   if (mainWindow) applyTitleBarTheme(mainWindow)
// })

function isWindows11(): boolean {
  return process.platform === 'win32' && Number(os.release().split('.')[2] ?? 0) >= 22000
}

function createWindow() {
  const iconPath = getIconPath(nativeTheme.shouldUseDarkColors)
  const isWin11 = isWindows11()

  mainWindow = new BrowserWindow({
    title: 'Graviton',
    icon: iconPath,
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true, // Enable webview for YouTube embeds (fixes Error 153)
      spellcheck: true,
    },
    // Platform-specific title bar settings
    ...(process.platform === 'win32'
      ? {
          frame: false,
          titleBarOverlay: false,
          backgroundMaterial: isWin11 ? 'acrylic' : 'none',
        }
      : process.platform === 'darwin'
        ? {
            titleBarStyle: 'hiddenInset',
            vibrancy: 'under-window',
            visualEffectState: 'active',
          }
        : {
            titleBarStyle: 'default', // Native title bar for Linux (safest)
          }),
    show: false, // Don't show until ready
  })

  if (process.platform === 'win32' && isWin11) {
    mainWindow.setBackgroundMaterial('acrylic')
  }

  // applyTitleBarTheme(mainWindow)

  // Show window when ready to avoid flicker
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
  })

  // Load the app
  // Use app.isPackaged for reliable detection (true when running from installer)
  const isDev = !app.isPackaged

  if (!isDev) {
    mainWindow.setMenu(null) // removes File/Edit/View in production
    mainWindow.removeMenu() // defensive (older Electron versions)
  }

  if (isDev) {
    // Development: Load from Vite dev server
    mainWindow.loadURL('http://localhost:5173')
  } else {
    // Production: Load from built files
    const indexPath = path.join(__dirname, '../dist-electron/index.html')
    console.log('[Electron] Production mode - loading from:', indexPath)

    // Add error listeners BEFORE loading
    mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
      console.error('[Electron] Failed to load:', { errorCode, errorDescription, validatedURL })
    })

    mainWindow.webContents.on('did-finish-load', () => {
      console.log('[Electron] Page finished loading')
    })

    // mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    //   // console.log('[Renderer Console]', { level, message, line, sourceId })
    // })

    mainWindow.loadFile(indexPath)

    // DEBUG: Force DevTools to open after a delay
    if (!app.isPackaged) {
      // if (true) {
      setTimeout(() => {
        console.log('[Electron] Force opening DevTools...')
        mainWindow?.webContents.openDevTools({ mode: 'detach' })
      }, 3000)
    }
  }

  if (shouldOpenDetachedDevTools) {
    // Open detached devtools as soon as possible, then retry once after load for reliability.
    mainWindow.webContents.openDevTools({ mode: 'detach' })
    mainWindow.webContents.once('did-finish-load', () => {
      if (!mainWindow?.webContents.isDevToolsOpened()) {
        mainWindow?.webContents.openDevTools({ mode: 'detach' })
      }
    })
  }

  mainWindow.on('close', event => {
    // In debug/dev mode we want a normal close so each `npm run electron` starts fresh.
    if (!isQuitting && !isDebugMode) {
      event.preventDefault()
      mainWindow?.hide()
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // Custom context menu with spell check
  mainWindow.webContents.on('context-menu', (_event, params) => {
    const menuItems: Electron.MenuItemConstructorOptions[] = []

    // Spell check suggestions
    if (params.misspelledWord) {
      for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
        menuItems.push({
          label: suggestion,
          click: () => mainWindow?.webContents.replaceMisspelling(suggestion),
        })
      }
      if (params.dictionarySuggestions.length > 0) {
        menuItems.push({ type: 'separator' })
      }
      menuItems.push({
        label: 'Add to Dictionary',
        click: () => mainWindow?.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord),
      })
      menuItems.push({ type: 'separator' })
    }

    // Standard edit actions
    menuItems.push(
      { role: 'undo', enabled: params.editFlags.canUndo },
      { role: 'redo', enabled: params.editFlags.canRedo },
      { type: 'separator' },
      { role: 'cut', enabled: params.editFlags.canCut },
      { role: 'copy', enabled: params.editFlags.canCopy },
      { role: 'paste', enabled: params.editFlags.canPaste },
      { type: 'separator' },
      { role: 'selectAll', enabled: params.editFlags.canSelectAll }
    )

    Menu.buildFromTemplate(menuItems).popup()
  })
}

function createTray() {
  if (tray) return
  const iconPath = getIconPath(nativeTheme.shouldUseDarkColors)
  tray = new Tray(iconPath)
  tray.setToolTip('Graviton')
  tray.on('click', () => {
    if (mainWindow) {
      mainWindow.show()
      mainWindow.focus()
    } else {
      createWindow()
    }
  })

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Open',
      click: () => {
        if (mainWindow) {
          mainWindow.show()
          mainWindow.focus()
        } else {
          createWindow()
        }
      },
    },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true
        app.quit()
      },
    },
  ])
  tray.setContextMenu(contextMenu)
}

// Create a floating popup window (like picture-in-picture)
function createFloatingWindow() {
  if (floatingWindow) {
    floatingWindow.focus()
    return
  }

  const iconPath = getIconPath(nativeTheme.shouldUseDarkColors)

  floatingWindow = new BrowserWindow({
    title: 'Graviton - Floating',
    icon: iconPath,
    width: 600,
    height: 400,
    minWidth: 300,
    minHeight: 200,
    alwaysOnTop: true,
    frame: false,
    transparent: true,
    resizable: true,
    skipTaskbar: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true, // Enable webview for YouTube embeds (fixes Error 153)
      spellcheck: true,
    },
  })

  // Set floating level for better visibility over fullscreen apps
  floatingWindow.setAlwaysOnTop(true, 'floating', 1)
  // Make window visible on all workspaces (including fullscreen apps)
  floatingWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  // Disable fullscreen to keep it as a floating window
  floatingWindow.setFullScreenable(false)

  // Show window when ready to avoid flicker
  floatingWindow.once('ready-to-show', () => {
    floatingWindow?.show()
  })

  // Load the app - use the same URL as main window
  const isDev = !app.isPackaged

  if (isDev) {
    floatingWindow.loadURL('http://localhost:5173')
  } else {
    const indexPath = path.join(__dirname, '../dist-electron/index.html')
    floatingWindow.loadFile(indexPath)
  }

  if (shouldOpenDetachedDevTools) {
    floatingWindow.webContents.openDevTools({ mode: 'detach' })
  }

  floatingWindow.on('closed', () => {
    floatingWindow = null
  })

  // Custom context menu with spell check
  floatingWindow.webContents.on('context-menu', (_event, params) => {
    const menuItems: Electron.MenuItemConstructorOptions[] = []

    // Spell check suggestions
    if (params.misspelledWord) {
      for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
        menuItems.push({
          label: suggestion,
          click: () => floatingWindow?.webContents.replaceMisspelling(suggestion),
        })
      }
      if (params.dictionarySuggestions.length > 0) {
        menuItems.push({ type: 'separator' })
      }
      menuItems.push({
        label: 'Add to Dictionary',
        click: () => floatingWindow?.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord),
      })
      menuItems.push({ type: 'separator' })
    }

    // Standard edit actions
    menuItems.push(
      { role: 'undo', enabled: params.editFlags.canUndo },
      { role: 'redo', enabled: params.editFlags.canRedo },
      { type: 'separator' },
      { role: 'cut', enabled: params.editFlags.canCut },
      { role: 'copy', enabled: params.editFlags.canCopy },
      { role: 'paste', enabled: params.editFlags.canPaste },
      { type: 'separator' },
      { role: 'selectAll', enabled: params.editFlags.canSelectAll }
    )

    Menu.buildFromTemplate(menuItems).popup()
  })
}

// Toggle floating window on/off
function toggleFloatingWindow() {
  if (floatingWindow) {
    floatingWindow.close()
    floatingWindow = null
  } else {
    createFloatingWindow()
  }
}

// Register protocol handler for OAuth callbacks
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])])
  }
} else {
  app.setAsDefaultProtocolClient(PROTOCOL)
}

// Handle protocol on macOS
app.on('open-url', (event, url) => {
  event.preventDefault()
  handleOAuthCallback(url)
})

// Handle protocol on Windows/Linux (via second instance)
// In debug mode, allow multiple instances so `npm run electron` always opens its own fresh window.
if (!isDebugMode) {
  const gotTheLock = app.requestSingleInstanceLock()

  if (!gotTheLock) {
    app.quit()
  } else {
    app.on('second-instance', (_event, commandLine) => {
      // Someone tried to run a second instance, we should focus our window.
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore()
        mainWindow.show()
        mainWindow.focus()
      }

      // The commandLine is an array of strings in which the last element is the deep link url
      // On Windows/Linux, the protocol URL will be in the command line arguments
      const url = commandLine.find(arg => arg.startsWith(`${PROTOCOL}://`))
      if (url) {
        handleOAuthCallback(url)
      }
    })
  }
} else {
  console.log('[Electron] Debug mode enabled: single-instance lock disabled')
}

// Handle OAuth callback from external browser
function handleOAuthCallback(url: string) {
  // Send the callback URL to the renderer process
  if (mainWindow && mainWindow.webContents) {
    mainWindow.webContents.send('oauth:callback', url)

    // Focus the window
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
}

// App lifecycle
app.whenReady().then(async () => {
  try {
    await initializeStore()
    syncHermesRuntimeSettingsFromStore()
    syncLmStudioBaseUrlFromStore()
    process.env.YGG_APP_USER_DATA = app.getPath('userData')
    const managedHooksDirectory = await ensureManagedHooksInitialized()
    console.log(`[Electron] Managed hooks directory ready at: ${managedHooksDirectory}`)
    const managedCustomToolsDirectory = await ensureManagedCustomToolsInitialized()
    console.log(`[Electron] Managed custom tools directory ready at: ${managedCustomToolsDirectory}`)
    const managedThemesDirectory = await ensureManagedThemesInitialized()
    console.log(`[Electron] Managed themes directory ready at: ${managedThemesDirectory}`)

    if (isDebugMode) {
      const debugReasons: string[] = []
      if (isEnvDevMode()) debugReasons.push('NODE_ENV/developer env')
      if (isNpmElectronRun) debugReasons.push('npm_lifecycle_event=electron')
      if (hasDebugModeArg) debugReasons.push('--debug-mode arg')
      console.log(`[Electron] Debug mode enabled (${debugReasons.join(', ') || 'manual'})`)
    }

    // Start local SQLite server for dual-sync (prefer 3002, fallback to other local ports)
    console.log(
      `[Electron] Local server bind host: ${LOCAL_SERVER_HOST}, advertise host: ${LOCAL_SERVER_ADVERTISE_HOST}, remote access: ${LOCAL_SERVER_ALLOW_REMOTE}`
    )
    try {
      const localDbPath = path.join(app.getPath('userData'), 'local-sync.db')
      const localServerInfo = await startLocalServer({
        preferredPort: LOCAL_SERVER_PREFERRED_PORT,
        fallbackPorts: LOCAL_SERVER_FALLBACK_PORTS,
        host: LOCAL_SERVER_HOST,
        allowEphemeralPort: LOCAL_SERVER_ALLOW_EPHEMERAL_PORT,
        dbPath: localDbPath,
      })
      localServerStarted = true
      localServerPort = localServerInfo.port
      localServerUrl = `http://${LOCAL_SERVER_ADVERTISE_HOST}:${localServerInfo.port}`
      const detectedLanHost = LOCAL_SERVER_ALLOW_REMOTE ? detectPreferredLanIpv4() : null
      localServerLanUrl = detectedLanHost ? `http://${detectedLanHost}:${localServerInfo.port}` : null
      localServerError = null
      process.env.YGG_LOCAL_SERVER_PORT = String(localServerInfo.port)
      process.env.YGG_LOCAL_SERVER_URL = localServerUrl
      if (localServerLanUrl) {
        process.env.YGG_LOCAL_SERVER_LAN_URL = localServerLanUrl
      } else {
        delete process.env.YGG_LOCAL_SERVER_LAN_URL
      }
      console.log(
        `[Electron] Local sync server started on ${localServerInfo.url} (renderer endpoint: ${localServerUrl}, lan endpoint: ${localServerLanUrl || 'n/a'})`
      )
    } catch (localServerStartError) {
      console.warn('[Electron] Failed to start local sync server:', localServerStartError)
      console.warn('[Electron] Continuing without local sync - data will not be synced locally')
      localServerStarted = false
      localServerPort = null
      localServerUrl = null
      localServerLanUrl = null
      delete process.env.YGG_LOCAL_SERVER_PORT
      delete process.env.YGG_LOCAL_SERVER_URL
      delete process.env.YGG_LOCAL_SERVER_LAN_URL
      localServerError =
        localServerStartError instanceof Error
          ? localServerStartError.message
          : `Failed to start local server: ${localServerStartError}`
    }

    // console.log('[Electron] Creating window...')
    createWindow()
    if (!isDebugMode) {
      createTray()
    }
    configureAutoUpdater()
  } catch (error) {
    console.error('[Electron] Failed to start:', error)
    app.quit()
  }
})

app.on('window-all-closed', () => {
  if (!isQuitting && !isDebugMode) {
    return
  }
  // Stop local sync server
  if (localServerStarted) {
    console.log('[Electron] Stopping local sync server...')
    stopLocalServer().catch(err => console.error('[Electron] Error stopping local server:', err))
    localServerStarted = false
    localServerPort = null
    localServerUrl = null
    localServerLanUrl = null
    delete process.env.YGG_LOCAL_SERVER_PORT
    delete process.env.YGG_LOCAL_SERVER_URL
    delete process.env.YGG_LOCAL_SERVER_LAN_URL
    localServerError = null
  }

  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

app.on('before-quit', () => {
  isQuitting = true
  for (const sessionId of Array.from(activeTerminalSessions.keys())) {
    destroyTerminalSession(sessionId)
  }
  // Ensure local sync server is stopped
  if (localServerStarted) {
    stopLocalServer().catch(err => console.error('[Electron] Error stopping local server on quit:', err))
    localServerStarted = false
    localServerPort = null
    localServerUrl = null
    localServerLanUrl = null
    delete process.env.YGG_LOCAL_SERVER_PORT
    delete process.env.YGG_LOCAL_SERVER_URL
    delete process.env.YGG_LOCAL_SERVER_LAN_URL
    localServerError = null
  }

  if (tray) {
    tray.destroy()
    tray = null
  }
})

// IPC Handlers for Electron-specific features

// Authentication (optional - for cloud sync)
ipcMain.handle('auth:login', async (_event, _credentials) => {
  // In Electron, we can store credentials securely using electron-store or keytar
  // For now, return a simple success
  // console.log('[Electron IPC] auth:login called')
  return { success: true, userId: 'electron-user-id' }
})

ipcMain.handle('auth:logout', async () => {
  // console.log('[Electron IPC] auth:logout called')
  // Clear stored credentials
  return { success: true }
})

// Storage - Persistent storage using electron-store with fallback
ipcMain.handle('storage:get', async (_event, key: string) => {
  // console.log('[Electron IPC] storage:get called for key:', key)

  if (!storeInitialized) {
    console.error('[Electron IPC] Storage not initialized yet')
    return null
  }

  try {
    const value = getFromStore(key)
    // console.log('[Electron IPC] Retrieved value:', value ? 'found' : 'not found')
    return value || null
  } catch (error) {
    console.error('[Electron IPC] Failed to get from storage:', error)
    return null
  }
})

ipcMain.handle('storage:set', async (_event, key: string, value: any) => {
  // console.log('[Electron IPC] storage:set called for key:', key)

  if (!storeInitialized) {
    console.error('[Electron IPC] Storage not initialized yet')
    return { success: false, error: 'Storage not initialized' }
  }

  try {
    if (value === null || value === undefined) {
      // Delete key if value is null/undefined
      const success = deleteFromStore(key)
      if (key === HERMES_RUNTIME_SETTINGS_STORAGE_KEY) {
        applyHermesRuntimeSettingsToEnv(null)
      }
      if (key === 'ygg_provider_settings') {
        syncLmStudioBaseUrlFromStore()
      }
      // console.log('[Electron IPC] Deleted key from storage')
      return { success }
    } else {
      const success = setInStore(key, value)
      if (key === HERMES_RUNTIME_SETTINGS_STORAGE_KEY) {
        applyHermesRuntimeSettingsToEnv(value)
      }
      if (key === 'ygg_provider_settings') {
        syncLmStudioBaseUrlFromStore()
      }
      // console.log('[Electron IPC] Stored successfully')
      return { success }
    }
  } catch (error) {
    console.error('[Electron IPC] Failed to set storage:', error)
    return { success: false, error: String(error) }
  }
})

// Clear all storage (for logout/account switching)
ipcMain.handle('storage:clear', async () => {
  // console.log('[Electron IPC] storage:clear called - clearing all stored data')

  if (!storeInitialized) {
    console.error('[Electron IPC] Storage not initialized yet')
    return { success: false, error: 'Storage not initialized' }
  }

  try {
    const success = clearStore()
    applyHermesRuntimeSettingsToEnv(null)
    syncLmStudioBaseUrlFromStore()
    return { success }
  } catch (error) {
    console.error('[Electron IPC] Failed to clear storage:', error)
    return { success: false, error: String(error) }
  }
})

ipcMain.handle('secrets:braveSearch:get', async () => {
  try {
    const value = await getBraveApiKey()
    return { success: true, value }
  } catch (error) {
    console.error('[Electron IPC] Failed to get Brave API key:', error)
    return { success: false, error: error instanceof Error ? error.message : String(error), value: null }
  }
})

ipcMain.handle('secrets:braveSearch:has', async () => {
  try {
    const configured = await hasBraveApiKey()
    return { success: true, configured }
  } catch (error) {
    console.error('[Electron IPC] Failed to check Brave API key:', error)
    return { success: false, error: error instanceof Error ? error.message : String(error), configured: false }
  }
})

ipcMain.handle('secrets:braveSearch:set', async (_event, value: string) => {
  try {
    await setBraveApiKey(value)
    return { success: true }
  } catch (error) {
    console.error('[Electron IPC] Failed to set Brave API key:', error)
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
})

ipcMain.handle('secrets:braveSearch:delete', async () => {
  try {
    await deleteBraveApiKey()
    return { success: true }
  } catch (error) {
    console.error('[Electron IPC] Failed to delete Brave API key:', error)
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
})

// Get platform info
ipcMain.handle('platform:info', async () => {
  return {
    platform: process.platform,
    version: app.getVersion(),
    isElectron: true,
  }
})

ipcMain.handle('autoUpdater:check', async () => {
  if (!autoUpdaterConfigured) {
    return { success: false, error: 'Auto-updater not configured' }
  }

  try {
    await autoUpdater.checkForUpdates()
    return { success: true }
  } catch (error) {
    console.error('[Electron] Manual update check failed:', error)
    return { success: false, error: String(error) }
  }
})

ipcMain.handle('autoUpdater:installNow', async () => {
  // console.log('[Electron] User requested immediate update install')
  try {
    // quitAndInstall will close the app and run the installer
    autoUpdater.quitAndInstall(false, true) // isSilent=false, isForceRunAfter=true
    return { success: true }
  } catch (error) {
    console.error('[Electron] Failed to install update:', error)
    return { success: false, error: String(error) }
  }
})

// Open OAuth URL in external browser
ipcMain.handle('auth:openExternal', async (_event, url: string) => {
  // console.log('[Electron IPC] Opening external URL for OAuth:', url)
  try {
    await shell.openExternal(url)
    return { success: true }
  } catch (error) {
    console.error('[Electron IPC] Failed to open external URL:', error)
    return { success: false, error: String(error) }
  }
})

// Open a file or folder path in the system file explorer
ipcMain.handle('shell:openPath', async (_event, path: string) => {
  // console.log('[Electron IPC] Opening path:', path)
  try {
    const result = await shell.openPath(path)
    if (result) {
      // openPath returns empty string on success, error message on failure
      return { success: false, error: result }
    }
    return { success: true }
  } catch (error) {
    console.error('[Electron IPC] Failed to open path:', error)
    return { success: false, error: String(error) }
  }
})

// File dialog for custom tool widgets
ipcMain.handle(
  'dialog:openFile',
  async (
    _event,
    options?: {
      title?: string
      defaultPath?: string
      filters?: { name: string; extensions: string[] }[]
      properties?: ('openFile' | 'openDirectory' | 'multiSelections' | 'showHiddenFiles')[]
    }
  ) => {
    // console.log('[Electron IPC] Opening file dialog with options:', options)
    try {
      const result = await dialog.showOpenDialog(mainWindow!, {
        title: options?.title || 'Select File',
        defaultPath: options?.defaultPath,
        filters: options?.filters,
        properties: options?.properties || ['openFile'],
      })
      return {
        success: !result.canceled,
        canceled: result.canceled,
        filePaths: result.filePaths,
      }
    } catch (error) {
      console.error('[Electron IPC] Failed to open file dialog:', error)
      return { success: false, error: String(error), filePaths: [] }
    }
  }
)

// Save dialog for custom tool widgets
ipcMain.handle(
  'dialog:saveFile',
  async (
    _event,
    options?: {
      title?: string
      defaultPath?: string
      filters?: { name: string; extensions: string[] }[]
    }
  ) => {
    // console.log('[Electron IPC] Opening save dialog with options:', options)
    try {
      const result = await dialog.showSaveDialog(mainWindow!, {
        title: options?.title || 'Save File',
        defaultPath: options?.defaultPath,
        filters: options?.filters,
      })
      return {
        success: !result.canceled,
        canceled: result.canceled,
        filePath: result.filePath,
      }
    } catch (error) {
      console.error('[Electron IPC] Failed to open save dialog:', error)
      return { success: false, error: String(error), filePath: undefined }
    }
  }
)

// Select folder dialog
ipcMain.handle('dialog:selectFolder', async (_event, options?: { title?: string; defaultPath?: string }) => {
  // console.log('[Electron IPC] Opening folder selection dialog')
  try {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: options?.title || 'Select Folder',
      defaultPath: options?.defaultPath,
      properties: ['openDirectory'],
    })
    return {
      success: !result.canceled,
      path: result.filePaths[0],
    }
  } catch (error) {
    console.error('[Electron IPC] Failed to open folder dialog:', error)
    return { success: false, error: String(error) }
  }
})

// Read file content for custom tool widgets
ipcMain.handle('fs:readFile', async (_event, filePath: string, encoding?: BufferEncoding) => {
  // console.log('[Electron IPC] Reading file:', filePath)
  try {
    const content = fs.readFileSync(filePath, encoding || 'utf-8')
    return { success: true, content }
  } catch (error) {
    console.error('[Electron IPC] Failed to read file:', error)
    return { success: false, error: String(error) }
  }
})

// Stat file for custom tool widgets
ipcMain.handle('fs:stat', async (_event, filePath: string) => {
  // console.log('[Electron IPC] Stating file:', filePath)
  try {
    const stats = await fs.promises.stat(filePath)
    return {
      success: true,
      size: stats.size,
      isFile: stats.isFile(),
      isDirectory: stats.isDirectory(),
      mtimeMs: stats.mtimeMs,
    }
  } catch (error) {
    console.error('[Electron IPC] Failed to stat file:', error)
    return { success: false, error: String(error) }
  }
})

// Stream file content for custom tool widgets
ipcMain.handle(
  'fs:readFileStream',
  async (
    event,
    filePath: string,
    options?: {
      encoding?: BufferEncoding
      highWaterMark?: number
    }
  ) => {
    // console.log('[Electron IPC] Streaming file:', filePath)
    try {
      const stats = await fs.promises.stat(filePath)
      const total = Number.isFinite(stats.size) ? stats.size : null
      const streamId = `stream_${Date.now()}_${Math.random().toString(16).slice(2)}`
      const stream = fs.createReadStream(filePath, {
        encoding: options?.encoding,
        highWaterMark: options?.highWaterMark,
      })

      const meta = {
        stream,
        sender: event.sender,
        loaded: 0,
        total,
        aborted: false,
        abortedSent: false,
      }
      activeReadStreams.set(streamId, meta)

      const sendToRenderer = (channel: string, payload: Record<string, any>) => {
        if (!meta.sender.isDestroyed()) {
          meta.sender.send(channel, payload)
        }
      }

      stream.on('data', (chunk: Buffer | string) => {
        const chunkSize =
          typeof chunk === 'string' ? Buffer.byteLength(chunk, options?.encoding || 'utf-8') : chunk.length
        meta.loaded += chunkSize
        sendToRenderer('fs:readFileStream:chunk', {
          streamId,
          chunk,
          loaded: meta.loaded,
          total: meta.total,
        })
        sendToRenderer('fs:readFileStream:progress', {
          streamId,
          loaded: meta.loaded,
          total: meta.total,
          percent: meta.total ? (meta.loaded / meta.total) * 100 : null,
        })
      })

      stream.on('end', () => {
        if (!meta.aborted) {
          sendToRenderer('fs:readFileStream:end', {
            streamId,
            loaded: meta.loaded,
            total: meta.total,
          })
        }
        activeReadStreams.delete(streamId)
      })

      stream.on('error', (error: Error) => {
        if (meta.aborted) {
          if (!meta.abortedSent) {
            sendToRenderer('fs:readFileStream:aborted', {
              streamId,
              loaded: meta.loaded,
              total: meta.total,
            })
            meta.abortedSent = true
          }
        } else {
          console.error('[Electron IPC] Stream error:', error)
          sendToRenderer('fs:readFileStream:error', {
            streamId,
            error: error.message,
            loaded: meta.loaded,
            total: meta.total,
          })
        }
        activeReadStreams.delete(streamId)
      })

      return { success: true, streamId, total }
    } catch (error) {
      console.error('[Electron IPC] Failed to stream file:', error)
      return { success: false, error: String(error) }
    }
  }
)

// Abort an active file stream
ipcMain.handle('fs:abortReadFileStream', async (_event, streamId: string) => {
  // console.log('[Electron IPC] Aborting file stream:', streamId)
  const meta = activeReadStreams.get(streamId)
  if (!meta) {
    return { success: false, error: 'Stream not found' }
  }

  meta.aborted = true
  if (!meta.abortedSent && !meta.sender.isDestroyed()) {
    meta.sender.send('fs:readFileStream:aborted', {
      streamId,
      loaded: meta.loaded,
      total: meta.total,
    })
    meta.abortedSent = true
  }
  meta.stream.destroy()
  activeReadStreams.delete(streamId)
  return { success: true }
})

// Write file content for custom tool widgets
ipcMain.handle('fs:writeFile', async (_event, filePath: string, content: string, encoding?: BufferEncoding) => {
  // console.log('[Electron IPC] Writing file:', filePath)
  try {
    // Handle base64 encoding for binary files (e.g., PDFs, images)
    if (encoding === 'base64') {
      fs.writeFileSync(filePath, Buffer.from(content, 'base64'))
    } else {
      fs.writeFileSync(filePath, content, encoding || 'utf-8')
    }
    return { success: true }
  } catch (error) {
    console.error('[Electron IPC] Failed to write file:', error)
    return { success: false, error: String(error) }
  }
})

ipcMain.handle('logs:getClientErrorLogPath', async () => {
  try {
    const filePath = getClientErrorLogPath()
    return { success: true, filePath }
  } catch (error) {
    console.error('[Electron IPC] Failed to resolve client error log path:', error)
    return { success: false, error: String(error) }
  }
})

ipcMain.handle('logs:appendClientError', async (_event, content: string) => {
  if (typeof content !== 'string' || content.length === 0) {
    return { success: true }
  }

  try {
    const filePath = getClientErrorLogPath()
    fs.appendFileSync(filePath, content, 'utf-8')
    return { success: true, filePath }
  } catch (error) {
    console.error('[Electron IPC] Failed to append client error log:', error)
    return { success: false, error: String(error) }
  }
})

// Create directory for custom tool widgets
ipcMain.handle('fs:mkdir', async (_event, dirPath: string) => {
  // console.log('[Electron IPC] Creating directory:', dirPath)
  try {
    fs.mkdirSync(dirPath, { recursive: true })
    return { success: true }
  } catch (error) {
    console.error('[Electron IPC] Failed to create directory:', error)
    return { success: false, error: String(error) }
  }
})

ipcMain.handle(
  'terminal:create',
  async (
    event,
    options?: {
      cwd?: string
      cols?: number
      rows?: number
      title?: string
    }
  ) => {
    try {
      const launch = await resolveTerminalLaunch(options?.cwd)
      const { spawn } = getNodePtyModule()
      const cols = clampTerminalDimension(options?.cols, 120, 20, 400)
      const rows = clampTerminalDimension(options?.rows, 32, 5, 200)
      const sessionId = makeTerminalSessionId()
      const pty = spawn(launch.file, launch.args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: launch.spawnCwd,
        env: {
          ...process.env,
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
        },
        ...(process.platform === 'win32' ? { useConpty: true } : {}),
      })

      const session: TerminalSessionRecord = {
        sessionId,
        pty,
        sender: event.sender,
        cwd: launch.displayCwd,
        shell: launch.shellLabel,
        cols,
        rows,
      }
      activeTerminalSessions.set(sessionId, session)

      event.sender.once('destroyed', () => {
        cleanupTerminalSessionsForSender(event.sender)
      })

      pty.onData(data => {
        const activeSession = activeTerminalSessions.get(sessionId)
        if (!activeSession) return
        sendTerminalEvent(activeSession.sender, 'terminal:data', {
          sessionId,
          data,
        })
      })

      pty.onExit(({ exitCode, signal }) => {
        const activeSession = activeTerminalSessions.get(sessionId)
        if (!activeSession) return
        activeTerminalSessions.delete(sessionId)
        sendTerminalEvent(activeSession.sender, 'terminal:exit', {
          sessionId,
          exitCode,
          signal,
          cwd: activeSession.cwd,
          shell: activeSession.shell,
        })
      })

      return {
        success: true,
        sessionId,
        cwd: launch.displayCwd,
        shell: launch.shellLabel,
        cols,
        rows,
        title: options?.title || 'Terminal',
      }
    } catch (error) {
      console.error('[Electron Terminal] Failed to create terminal session:', error)
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
)

ipcMain.handle('terminal:write', async (event, sessionId: string, data: string) => {
  const session = activeTerminalSessions.get(sessionId)
  if (!session || session.sender.id !== event.sender.id) {
    return { success: false, error: 'Terminal session not found' }
  }

  try {
    session.pty.write(typeof data === 'string' ? data : String(data ?? ''))
    return { success: true }
  } catch (error) {
    console.error('[Electron Terminal] Failed to write to terminal session:', error)
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
})

ipcMain.handle('terminal:resize', async (event, sessionId: string, cols: number, rows: number) => {
  const session = activeTerminalSessions.get(sessionId)
  if (!session || session.sender.id !== event.sender.id) {
    return { success: false, error: 'Terminal session not found' }
  }

  try {
    const nextCols = clampTerminalDimension(cols, session.cols || 120, 20, 400)
    const nextRows = clampTerminalDimension(rows, session.rows || 32, 5, 200)
    session.cols = nextCols
    session.rows = nextRows
    session.pty.resize(nextCols, nextRows)
    return { success: true }
  } catch (error) {
    console.error('[Electron Terminal] Failed to resize terminal session:', error)
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
})

ipcMain.handle('terminal:kill', async (event, sessionId: string) => {
  const session = activeTerminalSessions.get(sessionId)
  if (!session || session.sender.id !== event.sender.id) {
    return { success: false, error: 'Terminal session not found' }
  }

  destroyTerminalSession(sessionId)
  return { success: true }
})

// Execute shell command for custom tool widgets
ipcMain.handle('shell:exec', async (_event, command: string, options?: { cwd?: string; timeout?: number }) => {
  // console.log('[Electron IPC] Executing command:', command)
  const { spawn } = require('child_process')

  return new Promise(resolve => {
    const timeout = options?.timeout || 300000 // 5 min default
    let stdout = ''
    let stderr = ''
    let killed = false

    const child = spawn(command, [], {
      shell: true,
      cwd: options?.cwd,
    })

    const timer = setTimeout(() => {
      killed = true
      child.kill('SIGTERM')
    }, timeout)

    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString()
    })

    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    child.on('close', (code: number | null) => {
      clearTimeout(timer)
      resolve({
        success: code === 0,
        code,
        stdout,
        stderr,
        killed,
      })
    })

    child.on('error', (err: Error) => {
      clearTimeout(timer)
      resolve({
        success: false,
        error: err.message,
        stdout,
        stderr,
      })
    })
  })
})

// HTTP request handler for custom tool widgets (enables calling local/remote APIs)
ipcMain.handle(
  'http:request',
  async (
    _event,
    options: {
      url: string
      method?: string
      headers?: Record<string, string>
      body?: string
      timeout?: number
    }
  ) => {
    // console.log('[Electron IPC] HTTP request:', options.method || 'GET', options.url)

    const http = require('http')
    const https = require('https')
    const { URL } = require('url')

    return new Promise(resolve => {
      try {
        const url = new URL(options.url)
        const isHttps = url.protocol === 'https:'
        const lib = isHttps ? https : http

        const timeout = options.timeout || 30000

        const reqOptions = {
          hostname: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: url.pathname + url.search,
          method: options.method || 'GET',
          headers: {
            'Content-Type': 'application/json',
            ...options.headers,
          },
          timeout,
        }

        const req = lib.request(reqOptions, (res: any) => {
          let data = ''

          res.on('data', (chunk: Buffer) => {
            data += chunk.toString()
          })

          res.on('end', () => {
            let parsedData: any = data
            try {
              parsedData = JSON.parse(data)
            } catch {
              // Keep as string if not JSON
            }

            resolve({
              success: res.statusCode >= 200 && res.statusCode < 300,
              status: res.statusCode,
              statusText: res.statusMessage,
              headers: res.headers,
              data: parsedData,
            })
          })
        })

        req.on('error', (err: Error) => {
          console.error('[Electron IPC] HTTP request error:', err)
          resolve({
            success: false,
            error: err.message,
          })
        })

        req.on('timeout', () => {
          req.destroy()
          resolve({
            success: false,
            error: 'Request timeout',
          })
        })

        if (options.body) {
          req.write(options.body)
        }

        req.end()
      } catch (err) {
        console.error('[Electron IPC] HTTP request setup error:', err)
        resolve({
          success: false,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })
  }
)

// Custom tool module execution - runs tool's index.js in Electron's Node.js environment
// This allows custom tools with node_modules to work without user having Node.js installed
const loadedToolModules = new Map<string, any>()

ipcMain.handle(
  'customTool:execute',
  async (
    _event,
    toolPath: string,
    args?: Record<string, any>
  ): Promise<{ success: boolean; result?: any; error?: string }> => {
    console.log('[Electron IPC] Executing custom tool module:', toolPath)

    try {
      // Validate path exists
      if (!fs.existsSync(toolPath)) {
        return { success: false, error: `Tool path does not exist: ${toolPath}` }
      }

      // Determine the entry point
      let entryPoint = toolPath
      const stats = fs.statSync(toolPath)

      if (stats.isDirectory()) {
        // Look for package.json to find main entry
        const packageJsonPath = path.join(toolPath, 'package.json')
        if (fs.existsSync(packageJsonPath)) {
          try {
            const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'))
            entryPoint = path.join(toolPath, packageJson.main || 'index.js')
          } catch {
            entryPoint = path.join(toolPath, 'index.js')
          }
        } else {
          entryPoint = path.join(toolPath, 'index.js')
        }
      }

      if (!fs.existsSync(entryPoint)) {
        return { success: false, error: `Entry point not found: ${entryPoint}` }
      }

      // Clear require cache to allow hot reloading during development
      const resolvedPath = require.resolve(entryPoint)
      if (loadedToolModules.has(resolvedPath)) {
        // Use cached module for performance, but allow cache bust via args
        if (!args?._bustCache) {
          const cachedModule = loadedToolModules.get(resolvedPath)
          if (typeof cachedModule?.execute === 'function') {
            const result = await cachedModule.execute(args || {})
            return { success: true, result }
          }
        }
      }

      // Clear from Node's require cache to get fresh module
      delete require.cache[resolvedPath]

      // Load the tool module using Electron's Node.js runtime
      const toolModule = require(resolvedPath)
      loadedToolModules.set(resolvedPath, toolModule)

      // Check if module exports an execute function
      if (typeof toolModule?.execute !== 'function') {
        return {
          success: false,
          error: `Tool module must export an 'execute' function. Found: ${Object.keys(toolModule || {}).join(', ') || 'nothing'}`,
        }
      }

      // Execute the tool with provided args
      const result = await toolModule.execute(args || {})
      return { success: true, result }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      const errorStack = error instanceof Error ? error.stack : ''
      console.error('[Electron IPC] Custom tool execution failed:', errorMsg)
      console.error('[Electron IPC] Stack:', errorStack)
      return { success: false, error: errorMsg }
    }
  }
)

// Clear a specific tool from cache (for development/hot reload)
ipcMain.handle('customTool:clearCache', async (_event, toolPath?: string) => {
  if (toolPath) {
    const resolvedPath = require.resolve(toolPath)
    loadedToolModules.delete(resolvedPath)
    delete require.cache[resolvedPath]
    return { success: true, cleared: 1 }
  } else {
    const count = loadedToolModules.size
    loadedToolModules.clear()
    // Clear all tool modules from require cache
    Object.keys(require.cache).forEach(key => {
      if (key.includes('custom-tools')) {
        delete require.cache[key]
      }
    })
    return { success: true, cleared: count }
  }
})

ipcMain.handle('browser:isGuestDevToolsEnabled', async () => {
  return isGuestBrowserDevToolsEnabled()
})

ipcMain.handle('browser:openGuestDevTools', async (event, guestWebContentsId: number) => {
  if (!isGuestBrowserDevToolsEnabled()) {
    return { success: false, error: 'Browser DevTools are currently disabled in Settings.' }
  }

  if (!Number.isInteger(guestWebContentsId) || guestWebContentsId <= 0) {
    return { success: false, error: 'A valid guest webContentsId is required.' }
  }

  try {
    const guestContents = webContents.fromId(guestWebContentsId)
    if (!guestContents || guestContents.isDestroyed()) {
      return { success: false, error: 'Browser tab contents were not found.' }
    }

    if (guestContents.getType() !== 'webview') {
      return { success: false, error: 'DevTools can only be opened for embedded browser tabs.' }
    }

    const owningHostId = (guestContents as any).hostWebContents?.id
    if (typeof owningHostId === 'number' && owningHostId !== event.sender.id) {
      return { success: false, error: 'The requested browser tab belongs to a different renderer.' }
    }

    guestContents.openDevTools({ mode: 'detach', activate: true })
    return { success: true }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to open browser DevTools.',
    }
  }
})

// Floating window controls
ipcMain.handle('window:openFloating', async () => {
  // console.log('[Electron IPC] Opening floating window')
  try {
    createFloatingWindow()
    return { success: true }
  } catch (error) {
    console.error('[Electron IPC] Failed to open floating window:', error)
    return { success: false, error: String(error) }
  }
})

ipcMain.handle('window:closeFloating', async () => {
  // console.log('[Electron IPC] Closing floating window')
  try {
    if (floatingWindow) {
      floatingWindow.close()
      floatingWindow = null
      return { success: true }
    }
    return { success: true }
  } catch (error) {
    console.error('[Electron IPC] Failed to close floating window:', error)
    return { success: false, error: String(error) }
  }
})

ipcMain.handle('window:toggleFloating', async () => {
  // console.log('[Electron IPC] Toggling floating window')
  try {
    toggleFloatingWindow()
    return { success: true, isOpen: floatingWindow !== null }
  } catch (error) {
    console.error('[Electron IPC] Failed to toggle floating window:', error)
    return { success: false, error: String(error), isOpen: false }
  }
})

ipcMain.handle('window:isFloatingOpen', async () => {
  return floatingWindow !== null
})

// Compact mode controls (uses main window instead of spawning a new one)
ipcMain.handle('window:toggleCompact', async () => {
  // console.log('[Electron IPC] Toggling compact mode')
  try {
    const compact = toggleCompactMode()
    return { success: true, compact }
  } catch (error) {
    console.error('[Electron IPC] Failed to toggle compact mode:', error)
    return { success: false, error: String(error), compact: compactMode }
  }
})

ipcMain.handle('window:isCompact', async () => {
  return compactMode
})

// Open OAuth URL in a new BrowserWindow (for WSL/Linux compatibility)
ipcMain.handle('auth:openOAuthWindow', async (_event, url: string) => {
  // console.log('[Electron IPC] Opening OAuth window:', url)

  return new Promise(resolve => {
    // Create a modal window for OAuth
    const oauthWindow = new BrowserWindow({
      width: 500,
      height: 700,
      modal: true,
      parent: mainWindow || undefined,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
      title: 'Sign in',
      autoHideMenuBar: true,
    })

    // Load the OAuth URL
    oauthWindow.loadURL(url)

    // Handle navigation to callback URL
    const handleNavigation = (navigationUrl: string) => {
      // console.log('[Electron OAuth] Navigation detected:', navigationUrl)

      // Check if this is our callback URL
      if (navigationUrl.startsWith(`${PROTOCOL}://`)) {
        // console.log('[Electron OAuth] Callback URL detected, closing window')

        // Close the OAuth window
        oauthWindow.close()

        // Send the callback to handleOAuthCallback function
        handleOAuthCallback(navigationUrl)

        resolve({ success: true })
        return true
      }
      return false
    }

    // Listen for redirects (works for most OAuth providers)
    oauthWindow.webContents.on('will-redirect', (event, navigationUrl) => {
      if (handleNavigation(navigationUrl)) {
        event.preventDefault()
      }
    })

    // Listen for navigation (backup for providers that don't redirect)
    oauthWindow.webContents.on('will-navigate', (event, navigationUrl) => {
      if (handleNavigation(navigationUrl)) {
        event.preventDefault()
      }
    })

    // Handle window close
    oauthWindow.on('closed', () => {
      // console.log('[Electron OAuth] Window closed')
      resolve({ success: true })
    })

    // Handle errors
    oauthWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
      console.error('[Electron OAuth] Failed to load:', errorCode, errorDescription)
      oauthWindow.close()
      resolve({ success: false, error: errorDescription })
    })
  })
})

// Local sync server status
ipcMain.handle('sync:status', async () => {
  return {
    localServerRunning: localServerStarted,
    localServerPort,
    localServerUrl,
    localServerLanUrl,
    localServerError,
  }
})

// Window controls for custom title bar
ipcMain.handle('window:minimize', async () => {
  if (mainWindow) {
    mainWindow.minimize()
  }
})

ipcMain.handle('window:maximize', async () => {
  if (mainWindow) {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize()
    } else {
      mainWindow.maximize()
    }
  }
})

ipcMain.handle('window:close', async () => {
  if (mainWindow) {
    mainWindow.close()
  }
})

// Theme synchronization for native UI + Windows material.
ipcMain.handle('theme:update', async (_event, themePreference?: boolean | 'light' | 'dark' | 'system') => {
  let resolvedThemeSource: 'light' | 'dark' | 'system' = 'system'

  if (themePreference === 'light' || themePreference === 'dark' || themePreference === 'system') {
    resolvedThemeSource = themePreference
  } else if (typeof themePreference === 'boolean') {
    resolvedThemeSource = themePreference ? 'dark' : 'light'
  }

  nativeTheme.themeSource = resolvedThemeSource
})

function configureAutoUpdater() {
  if (autoUpdaterConfigured) {
    return
  }

  if (!app.isPackaged) {
    // console.log('[Electron] Auto-updater skipped: not packaged')
    return
  }

  if (!UPDATE_FEED_BASE_URL) {
    console.warn('[Electron] Auto-updater skipped: SUPABASE_UPDATE_FEED_BASE_URL missing')
    return
  }

  const platformDir = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux'

  const normalizedBase = UPDATE_FEED_BASE_URL.replace(/\/+$/, '')
  const feedUrl = `${normalizedBase}/${platformDir}`

  try {
    autoUpdater.setFeedURL({
      provider: 'generic',
      url: feedUrl,
    })
  } catch (error) {
    console.error('[Electron] Failed to set feed URL:', error)
    return
  }

  autoUpdaterConfigured = true

  autoUpdater.on('checking-for-update', () => {
    // console.log('[Electron] Checking for updates...')
    mainWindow?.webContents.send('autoUpdater:checking')
  })

  autoUpdater.on('update-available', info => {
    // console.log('[Electron] Update available:', info?.version)
    mainWindow?.webContents.send('autoUpdater:update-available', info)
  })

  autoUpdater.on('update-not-available', info => {
    // console.log('[Electron] No updates available')
    mainWindow?.webContents.send('autoUpdater:update-not-available', info)
  })

  autoUpdater.on('download-progress', progressObj => {
    mainWindow?.webContents.send('autoUpdater:download-progress', progressObj)
  })

  autoUpdater.on('update-downloaded', info => {
    // console.log('[Electron] Update downloaded, ready to install')
    mainWindow?.webContents.send('autoUpdater:update-downloaded', info)
    // Don't auto-install - let user choose via modal
  })

  autoUpdater.on('error', error => {
    // console.error('[Electron] Auto-updater error:', error)
    mainWindow?.webContents.send('autoUpdater:error', error ? error.message || String(error) : 'Unknown error')
  })

  setTimeout(() => {
    autoUpdater
      .checkForUpdatesAndNotify()
      .then(result => {
        if (!result?.downloadPromise) {
          console.log('[Electron] No update download triggered')
        }
      })
      .catch(error => {
        console.error('[Electron] Failed to check for updates:', error)
      })
  }, 3000)
}

function enterCompactMode() {
  if (!mainWindow) return

  // Save current bounds to restore later
  savedBounds = mainWindow.getBounds()

  // Remove fullscreen if active and prevent entering fullscreen
  mainWindow.setFullScreen(false)
  mainWindow.setFullScreenable(false)

  // Always on top over fullscreen apps
  mainWindow.setAlwaysOnTop(true, 'floating', 1)
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  // Reduce minimum size constraints for compact mode
  mainWindow.setMinimumSize(280, 200)

  // Compute a compact size and position (bottom-right of primary display)
  const display = screen.getPrimaryDisplay()
  const workArea = display.workArea
  const width = Math.min(Math.max(360, workArea.width * 0.32), 520)
  const height = Math.min(Math.max(480, workArea.height * 0.6), 760)
  const x = Math.floor(workArea.x + workArea.width - width - 16)
  const y = Math.floor(workArea.y + workArea.height - height - 16)

  mainWindow.setBounds({ x, y, width, height })

  compactMode = true
}

function exitCompactMode() {
  if (!mainWindow) return

  // Restore original minimum size constraints
  mainWindow.setMinimumSize(800, 600)

  // Restore previous bounds if available
  if (savedBounds) {
    mainWindow.setBounds(savedBounds)
  }

  mainWindow.setAlwaysOnTop(false)
  mainWindow.setVisibleOnAllWorkspaces(false)
  mainWindow.setFullScreenable(true)

  compactMode = false
}

function toggleCompactMode() {
  if (compactMode) {
    exitCompactMode()
  } else {
    enterCompactMode()
  }
  return compactMode
}

// Electron-side OpenAI ChatGPT streaming bridge. Renderer never receives raw OAuth tokens.
const activeOpenAIStreams = new Map<string, { aborted: boolean }>()

function openAIStorageAdapter() {
  return {
    get: (key: string) => getFromStore(key),
    set: (key: string, value: any) => setInStore(key, value),
    delete: (key: string) => deleteFromStore(key),
  }
}

function sendOpenAIStreamEvent(sender: Electron.WebContents, streamId: string, chunk: any): void {
  if (!sender.isDestroyed()) {
    sender.send('openai:chatgpt:stream-event', { streamId, chunk })
  }
}

ipcMain.handle('openai:chatgpt:isAuthenticated', async () => {
  const tokens = await getValidTokens(openAIStorageAdapter())
  return Boolean(tokens?.accessToken)
})

ipcMain.handle('openai:chatgpt:clearTokens', async () => {
  clearOpenAIStoredTokens(openAIStorageAdapter())
  return { success: true }
})

ipcMain.handle('openai:chatgpt:usage', async () => {
  return fetchOpenAIUsageStatus(openAIStorageAdapter())
})

ipcMain.handle('openai:chatgpt:stream-start', async (event, payload: any) => {
  const streamId = `openai_${Date.now()}_${Math.random().toString(16).slice(2)}`
  const state = { aborted: false }
  activeOpenAIStreams.set(streamId, state)

  void (async () => {
    try {
      const provider = new OpenAiChatgptProvider({
        tokenStore: {
          get: () => null,
          getLatest: () => null,
          upsert: () => {},
          delete: () => {},
        } as any,
      })
      const tokens = await getValidTokens(openAIStorageAdapter())
      if (!tokens) {
        throw new Error('OpenAI authentication required. Please sign in with your ChatGPT Plus/Pro account.')
      }
      const output = await provider.generate(
        {
          modelName: payload.modelName,
          systemPrompt: payload.systemPrompt || '',
          history: Array.isArray(payload.messages) ? payload.messages : [],
          userContent: '',
          accessToken: tokens.accessToken,
          accountId: tokens.accountId,
          tools: Array.isArray(payload.tools) ? payload.tools.map((tool: any) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema || tool.parameters })) : [],
          railwayTurn: {
            conversationId: String(payload.conversationId || ''),
            parentId: payload.parentId ?? null,
            think: payload.think,
            attachmentsBase64: payload.attachmentsBase64 ?? null,
            imageConfig: payload.imageConfig,
            reasoningConfig: payload.reasoningConfig,
            openaiHostedTools: payload.openaiHostedTools,
            isElectron: true,
          },
        },
        chunk => {
          if (!state.aborted) sendOpenAIStreamEvent(event.sender, streamId, chunk)
        }
      )
      if (!state.aborted) {
        sendOpenAIStreamEvent(event.sender, streamId, {
          type: 'complete',
          message: {
            id: payload.assistantMessageId || streamId,
            conversation_id: payload.conversationId,
            parent_id: payload.parentId ?? null,
            children_ids: [],
            role: 'assistant',
            content: output.content,
            content_plain_text: output.content,
            thinking_block: output.reasoning || '',
            tool_calls: output.toolCalls || [],
            model_name: payload.modelName,
            partial: false,
            created_at: new Date().toISOString(),
            artifacts: [],
            pastedContext: [],
            content_blocks: output.contentBlocks || [],
            responses_output_items: output.raw?.responses_output_items,
            generatedImagesDirectoryHint: output.raw?.generatedImagesDirectoryHint,
          },
        })
      }
    } catch (error) {
      if (!state.aborted) {
        sendOpenAIStreamEvent(event.sender, streamId, { type: 'error', error: error instanceof Error ? error.message : String(error) })
      }
    } finally {
      activeOpenAIStreams.delete(streamId)
    }
  })()

  return { success: true, streamId }
})

ipcMain.handle('openai:chatgpt:stream-abort', async (_event, streamId: string) => {
  const state = activeOpenAIStreams.get(streamId)
  if (state) state.aborted = true
  activeOpenAIStreams.delete(streamId)
  return { success: true }
})
