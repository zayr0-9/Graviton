import { startHostCatalogRefresh } from './services/hostCatalogClient'
import { setHostAppContextProvider } from './platform/hostAppClient'
import { updateToolEnabled as updateToolDefinitionEnabled } from './features/chats/toolDefinitions'
import { initializeHostExecutionPreferences, getHostExecutionPreferences, HOST_EXECUTION_CHANGED } from './services/hostExecutionClient'
import { chatSliceActions } from './features/chats/chatSlice'
import { initializeHostPrompts, startHostPromptRefresh } from './services/hostPromptClient'
import { startHostChangeClient } from './services/hostChangeClient'
// import { StrictMode } from 'react'
// import { createRoot } from 'react-dom/client'
// import './index.css'
// import App from './App.tsx'

// createRoot(document.getElementById('root')!).render(
//   <StrictMode>
//     <App />
//   </StrictMode>
// )

// main.tsx
// import React from 'react'
import { createSyncStoragePersister } from '@tanstack/query-sync-storage-persister'
import { QueryClient } from '@tanstack/react-query'
import { ReactQueryDevtools } from '@tanstack/react-query-devtools'
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client'
import ReactDOM from 'react-dom/client'
import { Provider } from 'react-redux'
import App from './App'
import { AuthProvider } from './contexts/AuthContext'
import './index.css'
import { applyAppFontSettings, FONT_SETTINGS_CHANGE_EVENT, FONT_SETTINGS_STORAGE_KEY } from './helpers/fontSettingsStorage'
import { initClientTelemetry } from './services/clientTelemetry'
import { store, startStoreServices } from './store/store'
import { bootstrapHostRuntime, getHostRuntime } from './services/hostRuntimeBootstrap'
import { isBrowserClient, isNativeShell } from './platform/clientCapabilities'
import { updateThunkExtraQueryClient } from './store/thunkExtra'

// Mark the document before host bootstrap/React: browsers must never use native glass.
if (!isNativeShell) document.documentElement.dataset.solidAppBackground = 'true'

// Configure React Query
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5000, // Data stays fresh for 5 seconds
      gcTime: 10 * 60 * 1000, // Cache persists for 10 minutes (renamed from cacheTime in v5)
      refetchOnWindowFocus: false, // Don't refetch on window focus
      refetchOnMount: false, // Don't refetch on component mount
      refetchOnReconnect: false, // Don't refetch on network reconnect
      refetchInterval: false, // Disable automatic polling
      refetchIntervalInBackground: false, // Disable background polling
      retry: 1, // Retry failed requests once
      networkMode: 'always', // Force request deduplication even when offline
    },
  },
})

// Make queryClient available to Redux thunks for cache synchronization
updateThunkExtraQueryClient(queryClient)

// Set explicit defaults for conversation and project queries to prevent background refetching
// This ensures cached queries from unmounted components (Homepage/ConversationPage)
// don't refetch when user is on Chat page
queryClient.setQueryDefaults(['conversations'], {
  refetchOnWindowFocus: false,
  refetchOnMount: false,
  refetchOnReconnect: false,
  refetchInterval: false,
})

queryClient.setQueryDefaults(['projects'], {
  refetchOnWindowFocus: false,
  refetchOnMount: false,
  refetchOnReconnect: false,
  refetchInterval: false,
})

// React Query cache persistence configuration
// Persists conversations and projects to localStorage to survive page refresh
const persister = createSyncStoragePersister({
  storage: isBrowserClient ? window.sessionStorage : window.localStorage,
  key: 'ygg-react-query-cache',
})

// Initialize Electron-only client error telemetry early in app startup.
initClientTelemetry()

// Global theme manager: keeps the `dark` class in sync with user preference and system theme
// Runs once per page load (guarded for HMR) so it applies across all routes
;(function initThemeManager() {
  if (typeof window === 'undefined') return
  const w = window as any
  if (w.__yggThemeInit) return
  w.__yggThemeInit = true

  const media = window.matchMedia('(prefers-color-scheme: dark)')

  const apply = () => {
    try {
      const pref = localStorage.getItem('theme') // 'light' | 'dark' | null (null => system)
      const isDark = pref === 'dark' || (pref !== 'light' && media.matches)
      document.documentElement.classList.toggle('dark', isDark)
      
      // Notify Electron to update title bar colors
      if (window.electronAPI?.theme?.update) {
        window.electronAPI.theme.update(isDark)
      }
    } catch {
      // If localStorage is blocked, fall back to system
      const isDark = media.matches
      document.documentElement.classList.toggle('dark', isDark)
      
      // Notify Electron to update title bar colors
      if (window.electronAPI?.theme?.update) {
        window.electronAPI.theme.update(isDark)
      }
    }
  }

  // Initial apply
  apply()

  // Update on system theme changes only when following system (no explicit preference)
  const onMediaChange = () => {
    try {
      if (!localStorage.getItem('theme')) apply()
    } catch {
      apply()
    }
  }
  if (typeof media.addEventListener === 'function') {
    media.addEventListener('change', onMediaChange)
  } else if (typeof (media as any).addListener === 'function') {
    ;(media as any).addListener(onMediaChange)
  }

  // React to preference changes from other tabs/windows
  window.addEventListener('storage', e => {
    if (e.key === 'theme') apply()
  })
})()

// Edit diff expansion animation preference: default off for virtualized-list scrolling performance.
;(function initEditDiffAnimationPreference() {
  if (typeof window === 'undefined') return
  const w = window as any
  if (w.__yggEditDiffAnimationPreferenceInit) return
  w.__yggEditDiffAnimationPreferenceInit = true

  const storageKey = 'chat:editDiffAnimationsEnabled'
  const apply = () => {
    try {
      const enabled = localStorage.getItem(storageKey) === 'true'
      document.documentElement.classList.toggle('edit-diff-animations-disabled', !enabled)
    } catch {
      document.documentElement.classList.add('edit-diff-animations-disabled')
    }
  }

  apply()

  window.addEventListener('storage', event => {
    if (event.key === storageKey) apply()
  })
})()

// Global font manager: applies saved app font preferences across routes.
;(function initFontManager() {
  if (typeof window === 'undefined') return
  const w = window as any
  if (w.__yggFontInit) return
  w.__yggFontInit = true

  const apply = () => {
    applyAppFontSettings().catch(error => {
      console.error('Failed to apply font settings:', error)
    })
  }

  // Initial apply
  apply()

  // React to in-app settings changes
  window.addEventListener(FONT_SETTINGS_CHANGE_EVENT, apply as EventListener)

  // React to updates from other tabs/windows
  window.addEventListener('storage', event => {
    if (event.key === FONT_SETTINGS_STORAGE_KEY) {
      apply()
    }
  })
})()

const rootElement = document.getElementById('root')
if (!rootElement) {
  throw new Error('Root element not found')
}

const root = ReactDOM.createRoot(rootElement)

void bootstrapHostRuntime().then(async () => {
await initializeHostPrompts()
await initializeHostExecutionPreferences()
const syncHostApproval = () => {
  const defaults = getHostExecutionPreferences()
  store.dispatch(chatSliceActions.hostToolApprovalDefaultReceived(defaults?.toolAutoApprove ?? false))
  for (const [toolName, enabled] of Object.entries(defaults?.tools ?? {})) {
    updateToolDefinitionEnabled(toolName, enabled)
    store.dispatch(chatSliceActions.toolEnabledUpdated({ toolName, enabled }))
  }
}
syncHostApproval()
window.addEventListener(HOST_EXECUTION_CHANGED, syncHostApproval)
import.meta.hot?.dispose(() => window.removeEventListener(HOST_EXECUTION_CHANGED, syncHostApproval))
const stopPrompts = startHostPromptRefresh()
window.addEventListener('pagehide', stopPrompts, { once: true })
import.meta.hot?.dispose(stopPrompts)
startStoreServices()
const stopCatalog = startHostCatalogRefresh(tools => store.dispatch(chatSliceActions.setTools(tools)))
window.addEventListener('pagehide', stopCatalog, { once: true })
import.meta.hot?.dispose(stopCatalog)
setHostAppContextProvider(() => ({ rootPath: store.getState().chat.conversation.ccCwd || null, mode: store.getState().chat.operationMode }))
const clearAccountCache = () => { void queryClient.cancelQueries(); queryClient.clear(); void persister.removeClient() }
window.addEventListener('graviton:foreign-host', () => {
  clearAccountCache()
  const notice = document.createElement('div')
  notice.setAttribute('role', 'alert'); notice.textContent = 'Another Graviton host is using this address. Requests are blocked. Copy unsaved drafts, then reload to choose this host.'
  notice.style.cssText = 'position:fixed;inset:0 0 auto;z-index:10000;padding:16px;background:#fff3cd;color:#332701'
  document.body.append(notice)
})
window.addEventListener('graviton:host-account-changed', clearAccountCache)
const stopChanges = startHostChangeClient(queryClient)
window.addEventListener('pagehide', stopChanges, { once: true })
import.meta.hot?.dispose(() => { stopChanges(); window.removeEventListener('graviton:host-account-changed', clearAccountCache) })
root.render(
  // StrictMode temporarily disabled to prevent double-mounting in development
  // which causes duplicate API requests and triggers rate limiting
  // TODO: Re-enable once request deduplication is fully stable
  // <React.StrictMode>
  <PersistQueryClientProvider
    client={queryClient}
    persistOptions={{
      persister,
      buster: isBrowserClient ? `${getHostRuntime()?.hostId}:${getHostRuntime()?.auth.user?.id ?? 'signed-out'}` : undefined,
      maxAge: 24 * 60 * 60 * 1000, // Persist cache for 24 hours max
      dehydrateOptions: {
        // Persist lightweight conversation/project queries, but exclude heavy per-conversation message payloads.
        shouldDehydrateQuery: query => {
          const queryKey = query.queryKey
          if (!Array.isArray(queryKey) || queryKey.length === 0) return false

          const rootKey = queryKey[0]
          if (rootKey === 'projects') return true
          if (rootKey !== 'conversations') return false

          // Exclude ['conversations', conversationId, 'messages'] from localStorage persistence.
          return queryKey[2] !== 'messages'
        },
      },
    }}
  >
    <Provider store={store}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </Provider>
    <ReactQueryDevtools initialIsOpen={false} />
  </PersistQueryClientProvider>
  // </React.StrictMode>
)

}).catch(error => {
  rootElement.replaceChildren()
  const message = document.createElement('p')
  message.setAttribute('role', 'alert')
  message.textContent = error instanceof Error ? error.message : 'Could not connect to Graviton.'
  const retry = document.createElement('button')
  retry.textContent = 'Retry connection'
  retry.onclick = () => window.location.reload()
  rootElement.append(message, retry)
})
