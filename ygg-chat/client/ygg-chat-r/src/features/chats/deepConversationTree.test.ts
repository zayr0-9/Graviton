import { configureStore } from '@reduxjs/toolkit'
import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true,
    value: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined } })
})
import chatReducer, { chatSliceActions } from './chatSlice'
import { chatSelectionRequested } from './chatSelection'
import type { Message, ChatNode } from './chatTypes'
import { buildConversationTree } from './conversationTree'
import { buildMessageTransferPayload } from './messageTransfer'
import { finalizeChatTree, chatTreeSerializableCheck, chatTreeIngressMiddleware } from './immutableChatTree'
import { coordinateConversationSnapshot } from './conversationSnapshotCoordinator'
import { filterChatTree, layoutChatTree, walkChatTree } from '../../components/Heimdall/heimdallTreeTraversal'
import { buildKeyboardTree } from '../../components/Heimdall/heimdallKeyboard'

const chain = (length: number): Message[] => Array.from({ length }, (_, i) => ({
  id: `m${i}`, conversation_id: 'deep', parent_id: i ? `m${i - 1}` : null,
  children_ids: i + 1 < length ? [`m${i + 1}`] : [], role: 'assistant', content: 'text',
  created_at: '2026-01-01', artifacts: [], pastedContext: [], partial: false, model_name: 'test',
} as Message))

const createStore = () => configureStore({ reducer: { chat: chatReducer },
  middleware: getDefault => getDefault({ serializableCheck: chatTreeSerializableCheck }).prepend(chatTreeIngressMiddleware), devTools: false })

const assertTree = (tree: ChatNode | null, length: number) => {
  let count = 0
  for (const node of walkChatTree(tree!)) {
    if (!Object.isFrozen(node) || !Object.isFrozen(node.children)) throw new Error('Tree is not fully frozen')
    count++
  }
  expect(count).toBe(length)
}

describe('deep conversation trees', () => {
  it('loads and refreshes 20,000 messages through real QueryClient, reducer and development middleware', async () => {
    const store = createStore()
    const queryClient = new QueryClient()
    store.dispatch(chatSelectionRequested({ requestId: 'deep-1', source: 'test', target: { kind: 'conversation', conversationId: 'deep' } }))
    const rows = chain(20000)
    for (let pass = 0; pass < 2; pass++) {
      const result = await coordinateConversationSnapshot({ conversationId: 'deep', queryClient,
        getState: store.getState as any, dispatch: store.dispatch,
        fetchSnapshot: async () => ({ messages: rows, tree: null }) })
      expect(result.accepted).toBe(true)
      expect(store.getState().chat.conversation.messages.length).toBe(rows.length)
      assertTree(store.getState().chat.heimdall.treeData, rows.length)
    }
    store.dispatch(chatSliceActions.heimdallCompactModeToggled())
    store.dispatch(chatSliceActions.heimdallDataLoaded({ treeData: null }))
    expect(store.getState().chat.heimdall.treeData).toBeNull()
  })

  it('accepts an external unfrozen deep tree through the alternate ingestion action without freezing the caller', () => {
    let tree: ChatNode = { id: 'leaf', message: '', sender: 'assistant', children: [] }
    for (let i = 0; i < 20000; i++) tree = { ...tree, id: String(i), children: [tree] }
    const store = createStore()
    store.dispatch(chatSliceActions.heimdallDataLoaded({ treeData: tree }))
    assertTree(store.getState().chat.heimdall.treeData, 20001)
    expect(Object.isFrozen(tree)).toBe(false)
    store.dispatch({ type: chatSliceActions.heimdallDataLoaded.type, payload: { treeData: tree } })
    assertTree(store.getState().chat.heimdall.treeData, 20001)
  })

  it('filters, positions and indexes a deep tree without losing nodes or mutating input', () => {
    const tree = buildConversationTree(chain(20000))!
    const filtered = filterChatTree(tree, node => ({ promote: false, message: node.message }))[0]
    const positions = layoutChatTree(filtered, 20, 30)
    expect(Object.keys(positions).length).toBe(20000)
    expect(positions.m19999.y).toBe(19999 * 30)
    expect(buildKeyboardTree(filtered).get('m19999')?.parent).toBe('m19998')
    const promoted = filterChatTree(tree, node => ({ promote: node.id !== 'm19999', message: node.message }))
    expect(promoted.length).toBe(1)
    expect(promoted[0].id).toBe('m19999')
    assertTree(tree, 20000)
  })

  it('transfers a deep chain in source order without flattening its parent links', () => {
    const rows = chain(20000)
    const payload = buildMessageTransferPayload(rows, rows.map(row => row.id).reverse())
    expect(payload.length).toBe(20000)
    expect(payload[0].source_id).toBe('m0')
    expect(payload.at(-1)?.parent_source_id).toBe('m19998')
  })

  it('preserves shallow layout coordinates and sibling promotion order', () => {
    const tree = buildConversationTree([
      ...chain(3),
      { ...chain(1)[0], id: 'branch', parent_id: 'm0', children_ids: [] },
    ])!
    const positions = layoutChatTree(tree, 20, 30)
    expect([positions.m0.x, positions.m1.x, positions.m2.x, positions.branch.x]).toEqual([0, -10, -10, 10])
    const filtered = filterChatTree(tree, (node, siblings) => ({ promote: node.id === 'm1' && siblings, message: node.message }))[0]
    expect(filtered.children.map(node => node.id)).toEqual(['m2', 'branch'])
  })

  it('validates beneath shallow-frozen roots and rejects reference cycles', () => {
    const child: ChatNode = { id: 'child', message: '', sender: 'assistant', children: [] }
    const root: ChatNode = Object.freeze({ ...child, id: 'parent', children: [child] })
    assertTree(finalizeChatTree(root), 2)
    child.children.push(child)
    expect(() => finalizeChatTree(child)).toThrow('reference cycle')
  })
})
