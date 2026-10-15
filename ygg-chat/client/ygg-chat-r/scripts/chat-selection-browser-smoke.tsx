import React, { StrictMode, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { Provider, useSelector } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { HashRouter, Route, Routes, useParams } from 'react-router-dom'
import reducer from '../src/features/chats/chatSlice'
import { ChatSelectionProvider, useChatSelection } from '../src/components/ChatSelection/ChatSelectionProvider'
import { useConversationSnapshotCoordinator } from '../src/hooks/useConversationSnapshotCoordinator'
import { useTitleBarHistory } from '../src/components/TitleBar/useTitleBarHistory'

declare global {
  interface Window {
    __fetchSnapshot: (id: string, options: { signal?: AbortSignal }) => Promise<unknown>
    __runSelectionSmoke: () => Promise<string[]>
  }
}

const requests: Array<{ id: string; resolve: (data: any) => void; reject: (error: Error) => void }> = []
window.__fetchSnapshot = (id, options) => new Promise((resolve, reject) => {
  requests.push({ id, resolve, reject })
  options.signal?.addEventListener('abort', () => reject(new Error('Wrapped transport abort')), { once: true })
})
const store = configureStore({ reducer: { chat: reducer, users: () => ({ currentUser: { id: 'smoke-user' } }) } })
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
let snapshot: ReturnType<typeof useConversationSnapshotCoordinator>
let navigation: ReturnType<typeof useChatSelection>
let history: ReturnType<typeof useTitleBarHistory>

function Controls() {
  navigation = useChatSelection()
  history = useTitleBarHistory()
  return null
}
function ChatProbe() {
  const { id } = useParams()
  snapshot = useConversationSnapshotCoordinator(id!, 'local')
  const selection = useSelector((state: ReturnType<typeof store.getState>) => state.chat.selection)
  const messages = useSelector((state: ReturnType<typeof store.getState>) => state.chat.conversation.messages)
  const coordinator = useChatSelection()
  const current = snapshot
  useEffect(() => {
    if (current.error && current.isCurrentError() && !current.isFetching && !current.acceptedConversationId) {
      coordinator.snapshotFailed(id!, selection.requestId)
    } else {
      void coordinator.resolve(current.acceptedConversationId, current.refresh)
    }
  }, [coordinator, current.acceptedConversationId, current.refresh, selection.requestId, messages,
    current.error, current.isCurrentError, current.isFetching, id])
  return <div>{selection.status}</div>
}
const root = createRoot(document.getElementById('root')!)
const tick = () => new Promise(resolve => setTimeout(resolve, 10))
async function until(check: () => boolean, label: string) {
  for (let i = 0; i < 200; i++) { if (check()) return; await tick() }
  throw new Error(`Timed out: ${label}; selection=${JSON.stringify(store.getState().chat.selection)}`)
}
function assert(condition: boolean, label: string) { if (!condition) throw new Error(label) }
const latest = () => requests.at(-1)!
const empty = { messages: [], tree: null }
const ready = () => store.getState().chat.selection.status === 'ready'

window.__runSelectionSmoke = async () => {
  const checks: string[] = []
  root.render(<StrictMode><Provider store={store}><QueryClientProvider client={queryClient}>
    <HashRouter><ChatSelectionProvider><Controls /><Routes>
      <Route path='/chat/:projectId/:id' element={<ChatProbe />} />
      <Route path='/settings' element={<div>Settings</div>} />
    </Routes></ChatSelectionProvider></HashRouter>
  </QueryClientProvider></Provider></StrictMode>)
  await until(() => requests.length >= 1, 'StrictMode route request')
  await tick()
  latest().resolve(empty)
  await until(ready, 'initial selection')
  checks.push('Real StrictMode mount and snapshot acceptance')

  const oldRefresh = snapshot.refresh
  navigation.navigate('/settings')
  await until(() => location.hash === '#/settings' && history.canGoBack, 'Settings history entry')
  await tick()
  const count = requests.length
  history.goBack()
  await until(() => requests.length > count, 'topbar Back remount')
  const afterMount = requests.length
  await oldRefresh()
  assert(requests.length === afterMount, 'Unmounted callback started another fetch')
  latest().resolve(empty)
  await until(ready, 'Back selection ready')
  checks.push('Topbar Settings -> Back rejects stale unmounted refresh')

  const oldA = snapshot.refresh
  const beforeB = requests.length
  navigation.navigate('/chat/p/b')
  await until(() => requests.length > beforeB && latest().id === 'b', 'B request')
  latest().resolve(empty)
  await until(ready, 'B ready')
  const beforeA = requests.length
  history.goBack()
  await until(() => requests.length > beforeA && latest().id === 'a', 'Back to A request')
  const currentCount = requests.length
  await oldA()
  assert(requests.length === currentCount, 'First A visit callback took over new A')
  latest().reject(new Error('Simulated current load failure'))
  await until(() => store.getState().chat.selection.status === 'error', 'A failure')
  checks.push('Topbar A -> B -> A fences prior-visit callback')

  navigation.select(store.getState().chat.selection.target!, { inPlace: true, source: 'retry' })
  await until(() => requests.length > currentCount, 'Retry request')
  const retryCount = requests.length
  const replacing = snapshot.refresh()
  await until(() => requests.length > retryCount, 'replacement refresh')
  latest().resolve(empty)
  await replacing
  await until(ready, 'Retry recovered')
  checks.push('Retry recovers after its first load is superseded')

  const beforeC = requests.length
  navigation.navigate('/chat/p/c')
  await until(() => requests.length > beforeC && latest().id === 'c', 'C request')
  latest().reject(new Error('Temporary failure'))
  await until(() => store.getState().chat.selection.status === 'error', 'C failed')
  const failedRequest = store.getState().chat.selection.requestId
  const recovery = snapshot.refresh()
  latest().resolve(empty)
  await recovery
  await until(ready, 'automatic C recovery')
  assert(store.getState().chat.selection.requestId === failedRequest, 'Recovery invented navigation')
  checks.push('Successful background refresh recovers the same failed intent')

  const beforeD = requests.length
  navigation.navigate('/chat/p/d')
  await until(() => requests.length > beforeD && latest().id === 'd', 'D request')
  latest().reject(new Error('First visit failed'))
  await until(() => store.getState().chat.selection.status === 'error', 'D failed')
  const failedCount = requests.length
  navigation.navigate('/chat/p/d#target')
  await until(() => requests.length > failedCount, 'same-chat new route retry')
  assert(store.getState().chat.selection.status === 'pending', 'Old error poisoned new same-chat request')
  latest().resolve({ messages: [{ id: 'target', conversation_id: 'd', parent_id: null, children_ids: [], created_at: '2026-01-01' }], tree: null })
  await until(ready, 'same-chat target ready')
  assert(store.getState().chat.conversation.focusedChatMessageId === 'target', 'Lost same-chat hash focus')
  checks.push('Failed same-chat hash reentry reloads and resolves target')

  const beforeMissing = requests.length
  navigation.select({ kind: 'message', conversationId: 'd', messageId: 'late' }, { inPlace: true, source: 'search' })
  await until(() => requests.length > beforeMissing, 'missing target resolver refresh')
  const replacement = snapshot.refresh()
  await tick()
  assert(store.getState().chat.selection.status === 'pending', 'Superseded resolver fell back prematurely')
  latest().resolve({ messages: [{ id: 'late', conversation_id: 'd', parent_id: null, children_ids: [], created_at: '2026-01-02' }], tree: null })
  await replacement
  await until(ready, 'missing target ready')
  assert(store.getState().chat.conversation.focusedChatMessageId === 'late', 'Replacement target not selected')
  checks.push('Missing target resolver waits for superseding snapshot')
  root.unmount()
  queryClient.clear()
  return checks
}
