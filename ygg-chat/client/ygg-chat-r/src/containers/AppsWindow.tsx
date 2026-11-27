import { useEffect, useRef, useState } from 'react'
import { useHtmlIframeRegistry } from '../components/HtmlIframeRegistry/HtmlIframeRegistry'
import { HtmlToolsModal } from '../components/HtmlToolsModal/HtmlToolsModal'
import ProtectedRoute from '../components/ProtectedRoute'
import { fetchCustomTools } from '../features/chats'
import { selectCurrentUser } from '../features/users'
import { useAppDispatch, useAppSelector } from '../hooks/redux'
import { onAppsHandoff, reportAppsSnapshot } from '../platform/appsWindow'

// Wait this long for custom tool definitions: custom tool apps load from their UI entry URL,
// which the registry only knows once the definitions are in.
const TOOLS_WAIT_MS = 4000
// Show the Task Manager after this long even if no hand-off arrived (nothing was handed over).
const HANDOFF_WAIT_MS = 1500
const REPORT_DELAY_MS = 250

const AppsWindowBody = () => {
  const registry = useHtmlIframeRegistry()
  const registryRef = useRef(registry)
  registryRef.current = registry
  const dispatch = useAppDispatch()
  // The registry clears itself when the signed-in user changes; take hand-offs only after.
  const userId = useAppSelector(selectCurrentUser)?.id ?? null
  const [toolsReady, setToolsReady] = useState(false)
  const [received, setReceived] = useState(false)
  const receivedRef = useRef(false)

  useEffect(() => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      setToolsReady(true)
    }
    const timer = window.setTimeout(finish, TOOLS_WAIT_MS)
    void Promise.resolve(dispatch(fetchCustomTools())).finally(finish)
    return () => {
      done = true
      window.clearTimeout(timer)
    }
  }, [dispatch])

  useEffect(() => {
    if (!toolsReady || !userId) return
    const markReceived = () => {
      receivedRef.current = true
      setReceived(true)
    }
    const fallback = window.setTimeout(markReceived, HANDOFF_WAIT_MS)
    const off = onAppsHandoff(handoffs => {
      const current = registryRef.current
      if (!current) return
      let focusKey: string | null = null
      for (const handoff of handoffs) {
        current.importEntries(handoff.entries, handoff.mode)
        if (handoff.focusKey) focusKey = handoff.focusKey
      }
      current.openModal(focusKey)
      window.clearTimeout(fallback)
      markReceived()
    })
    return () => {
      window.clearTimeout(fallback)
      off?.()
    }
  }, [toolsReady, userId])

  // Report the list to Electron main, which hands it back to the main window on close.
  const entries = registry?.entries
  useEffect(() => {
    if (!received) return
    const timer = window.setTimeout(() => reportAppsSnapshot(registryRef.current?.exportEntries() ?? []), REPORT_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [entries, received])
  useEffect(() => {
    const flush = () => {
      if (receivedRef.current) reportAppsSnapshot(registryRef.current?.exportEntries() ?? [])
    }
    window.addEventListener('beforeunload', flush)
    return () => window.removeEventListener('beforeunload', flush)
  }, [])

  if (!registry) return null
  if (!received) {
    return (
      <div className='flex h-screen items-center justify-center font-mono text-xs text-neutral-500'>Loading apps…</div>
    )
  }
  return <HtmlToolsModal presentation='window' />
}

/** The detached apps window (`#/apps-window`): the Task Manager, owning the app iframes. */
export default function AppsWindow() {
  useEffect(() => {
    document.title = 'Graviton - Task Manager'
  }, [])
  return (
    <ProtectedRoute>
      <AppsWindowBody />
    </ProtectedRoute>
  )
}
