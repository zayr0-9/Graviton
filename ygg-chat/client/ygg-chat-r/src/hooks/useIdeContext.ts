import { useCallback, useEffect, useRef } from 'react'
import {
  addOpenFile,
  addSelectedFileForChat,
  FileInfo,
  IdeContext,
  removeOpenFile,
  selectIdeContext,
  SelectionInfo,
  setActiveFile,
  setAllFiles,
  setConnectionStatus,
  setCurrentSelection,
  setExtensions,
  setExtensionStatus,
  setOpenFiles,
  updateWorkspace,
} from '../features/ideContext'
import { useAppDispatch, useAppSelector } from '../store/hooks'
import { buildLocalWebSocketUrl, refreshLocalServerStatus } from '../utils/api'

// Global WebSocket connection shared across all hook instances
let globalWebSocket: WebSocket | null = null
let connectionAttempts = 0
let isConnecting = false
let globalDispatch: any = null
// Global context request timeout tracking so all hook instances share the same state
const contextRequestTimeoutsGlobal = new Map<number, ReturnType<typeof setTimeout>>()
let lastContextRequestTs = 0
let requestSeq = 0
// Global pending file requests and processed responses so all hook instances share the same state
const pendingFileRequestsGlobal = new Map<number, (content: string | null) => void>()
const processedFileResponsesGlobal = new Set<number>()
let fileRequestSeq = 0

interface UseIdeContextReturn {
  ideContext: IdeContext
  requestContext: (extensionId?: string | null) => void
  requestFileContent: (filePath: string, extensionId?: string | null) => Promise<string | null>
  availableFiles: string[]
  getFileByPath: (path: string) => FileInfo | null
}

export function useIdeContext(): UseIdeContextReturn {
  const dispatch = useAppDispatch()
  const ideContext = useAppSelector(selectIdeContext)

  // Update global dispatch reference
  globalDispatch = dispatch
  const maxReconnectAttempts = 5
  // Reconnect timeout remains per-hook; request tracking is global
  const reconnectTimeout = useRef<NodeJS.Timeout | null>(null)

  const requestContext = useCallback(
    (extensionId: string | null = ideContext.selectedExtensionId) => {
      if (globalWebSocket && globalWebSocket.readyState === WebSocket.OPEN) {
        // Debounce context requests to prevent spam
        const now = Date.now()
        if (now - lastContextRequestTs < 1000) {
          return
        }

        lastContextRequestTs = now
        // Generate unique requestId even if multiple calls in the same ms
        requestSeq = (requestSeq + 1) % 1000
        const requestId = now * 1000 + requestSeq
        globalWebSocket.send(
          JSON.stringify({
            type: 'request_context',
            requestId,
            timestamp: new Date().toISOString(),
            data: {
              extensionId: extensionId ?? null,
            },
          })
        )

        // Set timeout to mark extension as disconnected if no response
        const timeoutId = setTimeout(() => {
          dispatch(setExtensionStatus(false))
          contextRequestTimeoutsGlobal.delete(requestId)
        }, 10000)
        contextRequestTimeoutsGlobal.set(requestId, timeoutId)
      }
    },
    [dispatch, ideContext.selectedExtensionId]
  )

  const requestFileContent = (
    filePath: string,
    extensionId: string | null = ideContext.selectedExtensionId
  ): Promise<string | null> => {
    return new Promise(resolve => {
      const now = Date.now()
      fileRequestSeq = (fileRequestSeq + 1) % 1000
      const requestId = now * 1000 + fileRequestSeq

      if (globalWebSocket && globalWebSocket.readyState === WebSocket.OPEN) {
        // Set timeout to resolve with null if no response
        const timeoutId = setTimeout(() => {
          if (pendingFileRequestsGlobal.has(requestId)) {
            console.warn(`⚠️ Timeout waiting for file content: ${filePath}`)
            resolve(null)
            pendingFileRequestsGlobal.delete(requestId)
            processedFileResponsesGlobal.add(requestId) // Mark as processed to avoid duplicate warnings
          }
        }, 10000) // 10 second timeout

        // Store timeout ID with the resolver so we can clear it later
        const resolveWithCleanup = (content: string | null) => {
          clearTimeout(timeoutId)
          resolve(content)
        }

        // Store the resolver for later
        pendingFileRequestsGlobal.set(requestId, resolveWithCleanup)

        globalWebSocket.send(
          JSON.stringify({
            type: 'request_file_content',
            requestId,
            timestamp: new Date().toISOString(),
            data: {
              path: filePath,
              extensionId: extensionId ?? null,
            },
          })
        )
      } else {
        if (import.meta.env.VITE_ENVIRONMENT !== 'web') {
          console.warn('⚠️ Cannot request file content: WebSocket not connected')
        }
        resolve(null)
      }
    })
  }

  const addRecentActivity = (_type: IdeContext['recentActivity'][0]['type'], _filePath: string, _details?: any) => {
    // Recent activity is now handled by Redux reducers
    // This function is kept for compatibility but doesn't need to do anything
    // since the Redux actions handle activity tracking
  }

  const updateConnectionStatus = (isConnected: boolean) => {
    if (globalDispatch) {
      globalDispatch(setConnectionStatus(isConnected))
    }
  }

  const connect = async () => {
    // Prevent multiple simultaneous connection attempts
    if (isConnecting || (globalWebSocket && globalWebSocket.readyState === WebSocket.CONNECTING)) {
      return
    }

    // Disable IDE context in web environment
    if (import.meta.env.VITE_ENVIRONMENT === 'web') {
      return
    }

    try {
      isConnecting = true
      // Dynamically construct WebSocket URL from the same API base URL
      const apiBase = import.meta.env.VITE_API_URL || 'http://localhost:3001/api'
      const wsProtocol = apiBase.startsWith('https') ? 'wss' : 'ws'
      const wsHost = apiBase.replace(/^https?:\/\//, '').replace(/\/api$/, '')
      let websocketUrl = `${wsProtocol}://${wsHost}/ide-context?type=frontend&id=ygg-chat`

      // In Electron, discover the local sync server endpoint via IPC.
      if (import.meta.env.VITE_ENVIRONMENT === 'electron') {
        await refreshLocalServerStatus().catch(() => {
          // Best-effort refresh; URL builder has a safe fallback.
        })
        websocketUrl = await buildLocalWebSocketUrl('/ide-context?type=frontend&id=ygg-chat')
      }

      globalWebSocket = new WebSocket(websocketUrl)

      // Add a connection timeout
      const connectionTimeout = setTimeout(() => {
        if (globalWebSocket && globalWebSocket.readyState === WebSocket.CONNECTING) {
          console.warn('⚠️ IDE Context WebSocket connection timeout')
          globalWebSocket.close()
        }
      }, 10000) // 10 second timeout

      globalWebSocket.onopen = () => {
        clearTimeout(connectionTimeout)
        isConnecting = false
        updateConnectionStatus(true)
        connectionAttempts = 0

        // Auto-request context on new connection to sync state

        // Delay the context request slightly to ensure connection is stable
        setTimeout(() => {
          // Use debounced request to avoid duplicate sends from multiple mounts
          requestContext(ideContext.selectedExtensionId)
        }, 100)
      }

      globalWebSocket.onmessage = event => {
        try {
          const message = JSON.parse(event.data)

          if (!globalDispatch) {
            console.warn('⚠️ globalDispatch not available, skipping message processing')
            return
          }

          switch (message.type) {
            case 'extensions_overview': {
              const overview = message.data?.extensions || []
              if (Array.isArray(overview)) {
                console.log('[MonacoIdeSelection][useIdeContext] extensions_overview', {
                  total: overview.length,
                  connectedIds: overview
                    .filter((extension: { id?: string; isConnected?: boolean } | null | undefined) => extension?.isConnected)
                    .map((extension: { id?: string }) => extension.id || '(unknown)'),
                })
                globalDispatch(setExtensions(overview))
                if (!overview.some((extension: { isConnected?: boolean } | null | undefined) => extension?.isConnected)) {
                  console.log('[MonacoIdeSelection][useIdeContext] no connected extensions; forcing extensionConnected=false')
                  globalDispatch(setExtensionStatus(false))
                }
              }
              break
            }

            case 'project_state_update':
            case 'context_response': {
              // Clear the matching pending context timeout if requestId echoed; otherwise clear all
              const responseRequestIdRaw = message.requestId ?? message.data?.requestId
              const responseRequestId: number | undefined =
                typeof responseRequestIdRaw === 'string' ? Number(responseRequestIdRaw) : responseRequestIdRaw

              if (typeof responseRequestId === 'number' && contextRequestTimeoutsGlobal.has(responseRequestId)) {
                const tid = contextRequestTimeoutsGlobal.get(responseRequestId)!
                clearTimeout(tid)
                contextRequestTimeoutsGlobal.delete(responseRequestId)
              } else if (contextRequestTimeoutsGlobal.size > 0) {
                contextRequestTimeoutsGlobal.forEach(tid => clearTimeout(tid))
                contextRequestTimeoutsGlobal.clear()
              }

              // Check if this is a real extension response or the local server's empty fallback response.
              // The empty fallback shape still includes a truthy workspace object:
              // { workspace: { name: null, rootPath: null }, openFiles: [], allFiles: [], ... }
              // so we must inspect the workspace contents instead of the object itself.
              const projectState = message.data
              const workspaceInfo = projectState?.workspace
              const hasWorkspaceIdentity =
                typeof workspaceInfo === 'string'
                  ? workspaceInfo.trim().length > 0
                  : Boolean(workspaceInfo?.name || workspaceInfo?.rootPath)
              const isRealExtensionResponse = Boolean(
                projectState &&
                (hasWorkspaceIdentity ||
                  (projectState.allFiles && projectState.allFiles.length > 0) ||
                  (projectState.openFiles && projectState.openFiles.length > 0) ||
                  projectState.activeFile ||
                  projectState.currentSelection)
              )

              console.log('[MonacoIdeSelection][useIdeContext] context_response/project_state_update evaluated extension status', {
                messageType: message.type,
                hasWorkspaceIdentity,
                allFiles: Array.isArray(projectState?.allFiles) ? projectState.allFiles.length : null,
                openFiles: Array.isArray(projectState?.openFiles) ? projectState.openFiles.length : null,
                hasActiveFile: Boolean(projectState?.activeFile),
                hasCurrentSelection: Boolean(projectState?.currentSelection?.selectedText?.trim?.()),
                isRealExtensionResponse,
              })

              globalDispatch(setExtensionStatus(isRealExtensionResponse))

              if (projectState.workspace) {
                const name =
                  typeof projectState.workspace === 'string' ? projectState.workspace : projectState.workspace.name
                const rootPath = typeof projectState.workspace === 'string' ? null : projectState.workspace.rootPath

                globalDispatch(
                  updateWorkspace({
                    name,
                    rootPath,
                    totalFiles: projectState.allFiles?.length || 0,
                    lastScanned: new Date().toISOString(),
                  })
                )
              }

              if (projectState.openFiles) {
                globalDispatch(setOpenFiles(projectState.openFiles))
              }

              if (projectState.activeFile && projectState.openFiles) {
                const activeFile = projectState.openFiles.find((f: FileInfo) => f.path === projectState.activeFile)
                globalDispatch(setActiveFile(activeFile || null))
              }

              if (projectState.allFiles) {
                globalDispatch(setAllFiles(projectState.allFiles))
              }

              if ('currentSelection' in projectState) {
                if (isRealExtensionResponse) {
                  globalDispatch(setCurrentSelection(projectState.currentSelection || null))
                } else {
                  console.log(
                    '[MonacoIdeSelection][useIdeContext] ignoring fallback currentSelection update from non-extension context response',
                    {
                      messageType: message.type,
                      hasCurrentSelection: Boolean(projectState?.currentSelection?.selectedText?.trim?.()),
                    }
                  )
                }
              }
              break
            }

            case 'file_opened':
              const openedFile = message.data as FileInfo
              // if (import.meta.env.VITE_ENVIRONMENT === 'electron') {
              //   console.log('[IDE DEBUG][WS file_opened]', {
              //     path: openedFile.path,
              //     relativePath: openedFile.relativePath,
              //     directoryPath: (openedFile as any).directoryPath,
              //     relativeDirectoryPath: (openedFile as any).relativeDirectoryPath,
              //   })
              // }
              globalDispatch(addOpenFile(openedFile))
              addRecentActivity('file_opened', openedFile.path, { file: openedFile })
              break

            case 'file_closed':
              const closedFilePath = message.data.path
              globalDispatch(removeOpenFile(closedFilePath))
              addRecentActivity('file_closed', closedFilePath)
              break

            case 'active_file_changed':
              const activeFilePath = message.data.path
              // Use current Redux state to find the active file
              const currentOpenFiles = ideContext.openFiles
              const activeFile = activeFilePath ? currentOpenFiles.find(f => f.path === activeFilePath) || null : null
              globalDispatch(setActiveFile(activeFile))
              break

            case 'selection_changed': {
              const selection = message.data as SelectionInfo | null
              const selectedText = selection?.selectedText?.trim() || ''

              if (!selection || !selectedText) {
                globalDispatch(setCurrentSelection(null))
                break
              }

              globalDispatch(
                setCurrentSelection({
                  ...selection,
                  timestamp: new Date().toISOString(),
                })
              )
              addRecentActivity('selection_changed', selection.filePath, {
                selection: selection.selectedText.substring(0, 100),
              })
              break
            }

            case 'selection_cleared':
              globalDispatch(setCurrentSelection(null))
              break

            case 'file_contents_response':
              const fileContent = message.data
              // if (import.meta.env.VITE_ENVIRONMENT === 'electron') {
              //   console.log('[IDE DEBUG][WS file_contents_response]', {
              //     requestId: message.requestId ?? fileContent?.requestId,
              //     path: fileContent?.path,
              //     relativePath: fileContent?.relativePath,
              //     directoryPath: fileContent?.directoryPath,
              //     relativeDirectoryPath: fileContent?.relativeDirectoryPath,
              //   })
              // }
              const responseRequestIdRaw = message.requestId ?? fileContent?.requestId
              const responseRequestId: number | undefined =
                typeof responseRequestIdRaw === 'string' ? Number(responseRequestIdRaw) : responseRequestIdRaw

              // Check if we've already processed this response
              if (responseRequestId && processedFileResponsesGlobal.has(responseRequestId)) {
                break
              }

              globalDispatch(
                addSelectedFileForChat({
                  path: fileContent.path,
                  relativePath: fileContent.relativePath,
                  directoryPath: fileContent.directoryPath,
                  relativeDirectoryPath: fileContent.relativeDirectoryPath,
                  name: fileContent.name ? fileContent.name : fileContent.path,
                  contents: fileContent.contents,
                  contentLength: fileContent.contents?.length || 0,
                  requestId: responseRequestId,
                })
              )

              if (typeof responseRequestId === 'number' && pendingFileRequestsGlobal.has(responseRequestId)) {
                const resolve = pendingFileRequestsGlobal.get(responseRequestId)
                if (resolve) {
                  resolve(fileContent.contents)
                  pendingFileRequestsGlobal.delete(responseRequestId)
                  processedFileResponsesGlobal.add(responseRequestId)

                  // Clean up processed responses after a delay to prevent memory leaks
                  setTimeout(() => {
                    processedFileResponsesGlobal.delete(responseRequestId)
                  }, 30000) // 30 seconds
                }
              } else {
                console.warn('⚠️ No pending request found for requestId:', responseRequestIdRaw)
              }
              break

            case 'file_contents_error':
              const errorData = message.data
              console.error('❌ File content error:', errorData.path, errorData.error)
              // Resolve with null on error - check both message.requestId and data.requestId
              const errorRequestIdRaw = message.requestId ?? errorData.requestId
              const errorRequestId: number | undefined =
                typeof errorRequestIdRaw === 'string' ? Number(errorRequestIdRaw) : errorRequestIdRaw
              if (typeof errorRequestId === 'number' && pendingFileRequestsGlobal.has(errorRequestId)) {
                const resolve = pendingFileRequestsGlobal.get(errorRequestId)
                resolve?.(null)
                pendingFileRequestsGlobal.delete(errorRequestId)
              } else {
                console.warn('⚠️ No pending request found for error requestId:', errorRequestIdRaw)
              }
              break
          }
        } catch (error) {
          console.error('Failed to parse IDE context message:', error)
        }
      }

      globalWebSocket.onclose = () => {
        clearTimeout(connectionTimeout)
        isConnecting = false

        updateConnectionStatus(false)
        // Clear any outstanding context timeouts on close
        if (contextRequestTimeoutsGlobal.size > 0) {
          contextRequestTimeoutsGlobal.forEach(tid => clearTimeout(tid))
          contextRequestTimeoutsGlobal.clear()
        }

        // Only attempt to reconnect if this wasn't an intentional close
        if (connectionAttempts < maxReconnectAttempts) {
          const delay = Math.min(1000 * Math.pow(2, connectionAttempts), 30000)
          reconnectTimeout.current = setTimeout(() => {
            connectionAttempts++
            void connect()
          }, delay)
        } else {
          console.warn('⚠️ Max reconnection attempts reached, giving up')
        }
      }

      globalWebSocket.onerror = error => {
        clearTimeout(connectionTimeout)
        isConnecting = false
        console.error('❌ IDE Context WebSocket error:', error)
        console.warn('⚠️ IDE Context WebSocket connection failed - IDE features will be limited')
        updateConnectionStatus(false)
      }
    } catch (error) {
      console.error('Failed to connect to IDE Context WebSocket:', error)
      isConnecting = false
      updateConnectionStatus(false)
    }
  }

  const getFileByPath = (path: string): FileInfo | null => {
    return ideContext.openFiles.find(file => file.path === path || file.relativePath === path) || null
  }

  useEffect(() => {
    // Only connect if not already connected or connecting
    if (!globalWebSocket || globalWebSocket.readyState === WebSocket.CLOSED) {
      void connect()
    } else if (globalWebSocket.readyState === WebSocket.OPEN) {
      // Connection already exists - request context to sync state after refresh

      // Delay the context request slightly to ensure component is mounted
      setTimeout(() => {
        // Use debounced request to avoid duplicate sends from multiple mounts
        requestContext(ideContext.selectedExtensionId)
      }, 100)
    }

    return () => {
      // Don't close connection on unmount - let it persist across page changes
      // Cleanup will happen when the app actually closes
      if (reconnectTimeout.current) {
        clearTimeout(reconnectTimeout.current)
      }
      if (contextRequestTimeoutsGlobal.size > 0) {
        contextRequestTimeoutsGlobal.forEach(tid => clearTimeout(tid))
        contextRequestTimeoutsGlobal.clear()
      }
    }
  }, [])

  // Convert file paths to relative paths for @mention functionality
  const availableFiles = ideContext.allFiles
    .map(filePath => {
      // Extract relative path from absolute path
      const parts = filePath.split(/[/\\]/)
      const workspaceName = ideContext.workspace?.name

      if (workspaceName) {
        const workspaceIndex = parts.findIndex(part => part === workspaceName)
        if (workspaceIndex !== -1 && workspaceIndex < parts.length - 1) {
          return parts.slice(workspaceIndex + 1).join('/')
        }
      }

      // Fallback to filename if workspace detection fails
      return parts[parts.length - 1] || filePath
    })
    .filter(Boolean)

  return {
    ideContext,
    requestContext,
    requestFileContent,
    availableFiles,
    getFileByPath,
  }
}
