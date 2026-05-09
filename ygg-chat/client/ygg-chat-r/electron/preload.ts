import { contextBridge, ipcRenderer } from 'electron'

// Expose protected methods that allow the renderer process to use
// ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  auth: {
    login: (credentials: any) => ipcRenderer.invoke('auth:login', credentials),
    logout: () => ipcRenderer.invoke('auth:logout'),
    openExternal: (url: string) => ipcRenderer.invoke('auth:openExternal', url),
    openOAuthWindow: (url: string) => ipcRenderer.invoke('auth:openOAuthWindow', url),
    onOAuthCallback: (callback: (url: string) => void) => {
      const listener = (_event: any, url: string) => callback(url)
      ipcRenderer.on('oauth:callback', listener)
      // Return cleanup function
      return () => {
        ipcRenderer.removeListener('oauth:callback', listener)
      }
    },
  },
  storage: {
    get: (key: string) => ipcRenderer.invoke('storage:get', key),
    set: (key: string, value: any) => ipcRenderer.invoke('storage:set', key, value),
    clear: () => ipcRenderer.invoke('storage:clear'),
  },
  secrets: {
    braveSearch: {
      get: () => ipcRenderer.invoke('secrets:braveSearch:get'),
      has: () => ipcRenderer.invoke('secrets:braveSearch:has'),
      set: (value: string) => ipcRenderer.invoke('secrets:braveSearch:set', value),
      delete: () => ipcRenderer.invoke('secrets:braveSearch:delete'),
    },
  },
  platformInfo: {
    get: () => ipcRenderer.invoke('platform:info'),
  },
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximize: () => ipcRenderer.invoke('window:maximize'),
    close: () => ipcRenderer.invoke('window:close'),
    // Floating window controls
    openFloating: () => ipcRenderer.invoke('window:openFloating'),
    closeFloating: () => ipcRenderer.invoke('window:closeFloating'),
    toggleFloating: () => ipcRenderer.invoke('window:toggleFloating'),
    isFloatingOpen: () => ipcRenderer.invoke('window:isFloatingOpen'),
    // Compact mode controls
    toggleCompact: () => ipcRenderer.invoke('window:toggleCompact'),
    isCompact: () => ipcRenderer.invoke('window:isCompact'),
  },
  theme: {
    update: (themePreference: boolean | 'light' | 'dark' | 'system') =>
      ipcRenderer.invoke('theme:update', themePreference),
  },
  sync: {
    status: () => ipcRenderer.invoke('sync:status'),
  },
  shell: {
    openPath: (path: string) => ipcRenderer.invoke('shell:openPath', path),
  },
  browser: {
    isGuestDevToolsEnabled: () => ipcRenderer.invoke('browser:isGuestDevToolsEnabled'),
    openGuestDevTools: (webContentsId: number) => ipcRenderer.invoke('browser:openGuestDevTools', webContentsId),
  },
  dialog: {
    openFile: (options?: {
      title?: string
      defaultPath?: string
      filters?: { name: string; extensions: string[] }[]
      properties?: ('openFile' | 'openDirectory' | 'multiSelections' | 'showHiddenFiles')[]
    }) => ipcRenderer.invoke('dialog:openFile', options),
    saveFile: (options?: {
      title?: string
      defaultPath?: string
      filters?: { name: string; extensions: string[] }[]
    }) => ipcRenderer.invoke('dialog:saveFile', options),
    selectFolder: (options?: { title?: string; defaultPath?: string }) =>
      ipcRenderer.invoke('dialog:selectFolder', options),
  },
  fs: {
    readFile: (filePath: string, encoding?: BufferEncoding) => ipcRenderer.invoke('fs:readFile', filePath, encoding),
    writeFile: (filePath: string, content: string, encoding?: BufferEncoding) =>
      ipcRenderer.invoke('fs:writeFile', filePath, content, encoding),
    mkdir: (dirPath: string) => ipcRenderer.invoke('fs:mkdir', dirPath),
    stat: (filePath: string) => ipcRenderer.invoke('fs:stat', filePath),
    readFileStream: (
      filePath: string,
      options?: {
        encoding?: BufferEncoding
        highWaterMark?: number
      }
    ) => ipcRenderer.invoke('fs:readFileStream', filePath, options),
    abortReadFileStream: (streamId: string) => ipcRenderer.invoke('fs:abortReadFileStream', streamId),
    onReadFileStreamChunk: (callback: (payload: any) => void) => {
      const listener = (_event: any, payload: any) => callback(payload)
      ipcRenderer.on('fs:readFileStream:chunk', listener)
      return () => ipcRenderer.removeListener('fs:readFileStream:chunk', listener)
    },
    onReadFileStreamProgress: (callback: (payload: any) => void) => {
      const listener = (_event: any, payload: any) => callback(payload)
      ipcRenderer.on('fs:readFileStream:progress', listener)
      return () => ipcRenderer.removeListener('fs:readFileStream:progress', listener)
    },
    onReadFileStreamEnd: (callback: (payload: any) => void) => {
      const listener = (_event: any, payload: any) => callback(payload)
      ipcRenderer.on('fs:readFileStream:end', listener)
      return () => ipcRenderer.removeListener('fs:readFileStream:end', listener)
    },
    onReadFileStreamError: (callback: (payload: any) => void) => {
      const listener = (_event: any, payload: any) => callback(payload)
      ipcRenderer.on('fs:readFileStream:error', listener)
      return () => ipcRenderer.removeListener('fs:readFileStream:error', listener)
    },
    onReadFileStreamAborted: (callback: (payload: any) => void) => {
      const listener = (_event: any, payload: any) => callback(payload)
      ipcRenderer.on('fs:readFileStream:aborted', listener)
      return () => ipcRenderer.removeListener('fs:readFileStream:aborted', listener)
    },
  },
  logs: {
    appendClientError: (content: string) => ipcRenderer.invoke('logs:appendClientError', content),
    getClientErrorLogPath: () => ipcRenderer.invoke('logs:getClientErrorLogPath'),
  },
  exec: {
    run: (command: string, options?: { cwd?: string; timeout?: number }) =>
      ipcRenderer.invoke('shell:exec', command, options),
  },
  terminal: {
    create: (options?: { cwd?: string; cols?: number; rows?: number; title?: string }) =>
      ipcRenderer.invoke('terminal:create', options),
    write: (sessionId: string, data: string) => ipcRenderer.invoke('terminal:write', sessionId, data),
    resize: (sessionId: string, cols: number, rows: number) =>
      ipcRenderer.invoke('terminal:resize', sessionId, cols, rows),
    kill: (sessionId: string) => ipcRenderer.invoke('terminal:kill', sessionId),
    onData: (callback: (payload: any) => void) => {
      const listener = (_event: any, payload: any) => callback(payload)
      ipcRenderer.on('terminal:data', listener)
      return () => ipcRenderer.removeListener('terminal:data', listener)
    },
    onExit: (callback: (payload: any) => void) => {
      const listener = (_event: any, payload: any) => callback(payload)
      ipcRenderer.on('terminal:exit', listener)
      return () => ipcRenderer.removeListener('terminal:exit', listener)
    },
  },
  http: {
    request: (options: {
      url: string
      method?: string
      headers?: Record<string, string>
      body?: string
      timeout?: number
    }) => ipcRenderer.invoke('http:request', options),
  },
  openaiChatGPT: {
    streamStart: (payload: any) => ipcRenderer.invoke('openai:chatgpt:stream-start', payload),
    streamAbort: (streamId: string) => ipcRenderer.invoke('openai:chatgpt:stream-abort', streamId),
    isAuthenticated: () => ipcRenderer.invoke('openai:chatgpt:isAuthenticated'),
    clearTokens: () => ipcRenderer.invoke('openai:chatgpt:clearTokens'),
    usage: () => ipcRenderer.invoke('openai:chatgpt:usage'),
    onStreamEvent: (callback: (payload: any) => void) => {
      const listener = (_event: any, payload: any) => callback(payload)
      ipcRenderer.on('openai:chatgpt:stream-event', listener)
      return () => ipcRenderer.removeListener('openai:chatgpt:stream-event', listener)
    },
  },
  titleBar: {
    setOverlay: (payload: { color?: string; symbolColor?: string; height?: number }) =>
      ipcRenderer.invoke('titlebar:set-overlay', payload),
  },
  customTool: {
    execute: (toolPath: string, args?: Record<string, any>) =>
      ipcRenderer.invoke('customTool:execute', toolPath, args),
    clearCache: (toolPath?: string) => ipcRenderer.invoke('customTool:clearCache', toolPath),
  },
  autoUpdater: {
    check: () => ipcRenderer.invoke('autoUpdater:check'),
    installNow: () => ipcRenderer.invoke('autoUpdater:installNow'),
    onChecking: (callback: () => void) => {
      const listener = () => callback()
      ipcRenderer.on('autoUpdater:checking', listener)
      return () => ipcRenderer.removeListener('autoUpdater:checking', listener)
    },
    onUpdateAvailable: (callback: (info: any) => void) => {
      const listener = (_event: any, info: any) => callback(info)
      ipcRenderer.on('autoUpdater:update-available', listener)
      return () => ipcRenderer.removeListener('autoUpdater:update-available', listener)
    },
    onUpdateNotAvailable: (callback: (info: any) => void) => {
      const listener = (_event: any, info: any) => callback(info)
      ipcRenderer.on('autoUpdater:update-not-available', listener)
      return () => ipcRenderer.removeListener('autoUpdater:update-not-available', listener)
    },
    onDownloadProgress: (callback: (progress: any) => void) => {
      const listener = (_event: any, progress: any) => callback(progress)
      ipcRenderer.on('autoUpdater:download-progress', listener)
      return () => ipcRenderer.removeListener('autoUpdater:download-progress', listener)
    },
    onUpdateDownloaded: (callback: (info: any) => void) => {
      const listener = (_event: any, info: any) => callback(info)
      ipcRenderer.on('autoUpdater:update-downloaded', listener)
      return () => ipcRenderer.removeListener('autoUpdater:update-downloaded', listener)
    },
    onError: (callback: (error: string) => void) => {
      const listener = (_event: any, error: string) => callback(error)
      ipcRenderer.on('autoUpdater:error', listener)
      return () => ipcRenderer.removeListener('autoUpdater:error', listener)
    },
  },
  platform: process.platform,
})

// Log that preload script has loaded
console.log('[Electron Preload] Script loaded, electronAPI exposed')
