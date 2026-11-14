import { describe, expect, it, vi } from 'vitest'
vi.hoisted(() => {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null, setItem: () => {}, removeItem: () => {} } })
})
import reducer, { chatSliceActions as actions } from './chatSlice'
import { projectServerEvent, applyStreamProjectionPolicy } from './sseProjection'
import { selectCurrentViewStreamFor } from './chatSelectors'
import { chatSelectionCommitted, chatSelectionRequested, resolveLocalChatSelection, type ChatSelectionTarget } from './chatSelection'
import { reconcileConversationSnapshot } from './conversationSnapshotReconciliation'
import { buildConversationTree } from './conversationTree'
import type { Message } from './chatTypes'

// A run must stay attached to the view that shows its branch. Path advancement used to be
// adjacency-only, so one row the path did not adopt stranded the rest of the run: rows
// reached Heimdall but not the transcript, and the live stream stopped being the view's.
function world() {
  let clock = 0
  const db = new Map<string, Message>()
  const row = (id: string, parent_id: string | null, role: string, lineage_id: string) => {
    const prior = db.get(id)
    const next = {
      id, parent_id, role, conversation_id: 'c', content: '', children_ids: prior?.children_ids ?? [], content_blocks: [], lineage_id,
      revision: ((prior as any)?.revision ?? 0) + 1,
      created_at: prior?.created_at ?? new Date(Date.UTC(2026, 0, 1, 0, 0, clock++)).toISOString(),
    } as unknown as Message
    db.set(id, next)
    // Like the host, a parent lists its children: a row persisted again carries them.
    const parent = parent_id == null ? undefined : db.get(parent_id)
    if (parent && !parent.children_ids.includes(id)) db.set(parent_id!, { ...parent, children_ids: [...parent.children_ids, id] })
    return next
  }
  let state = reducer(undefined, { type: 'init' })
  const dispatch = (action: any) => { state = reducer(state, action) }
  let requests = 0
  const request = (target: ChatSelectionTarget) => {
    const requestId = `r${++requests}`
    dispatch(chatSelectionRequested({ requestId, target, source: 'route' }))
    return requestId
  }
  const commitLocal = (requestId: string) => {
    const c = state.conversation
    // Mirrors the controller, including the remembered branch for conversation-only routes.
    const resolved = resolveLocalChatSelection(state.selection.target!, c.messages,
      { conversationId: c.currentConversationId!, lineageId: c.currentLineageId, path: c.currentPath, focus: c.focusedChatMessageId },
      c.lastViewedTips?.[String(c.currentConversationId)] ?? null)
      ?? { conversationId: c.currentConversationId!, lineageId: null, path: [], focus: null }
    dispatch(chatSelectionCommitted({ ...resolved, requestId }))
  }
  // Mirrors coordinateConversationSnapshot: active-stream protection, reconcile, atomic apply.
  const snapshot = () => {
    const protections = state.streaming.activeIds.flatMap(id => {
      const s = state.streaming.byId[id]
      if (!s?.active || String(s.conversationId) !== 'c') return []
      return [{ messageIds: [s.messageId, s.triggerUserMessageId, s.currentBranchAnchorMessageId, s.branchAnchorMessageId,
        s.liveMessageId, s.lastCompletedMessageId, s.finalMessageId, s.streamingMessageId, s.lineage.rootMessageId,
        s.lineage.originMessageId].filter((x): x is string => x != null).map(String) }]
    })
    const messages = reconcileConversationSnapshot({ fetchedMessages: [...db.values()], liveMessages: state.conversation.messages, protections })
    dispatch(actions.conversationSnapshotApplied({ conversationId: 'c', messages, tree: buildConversationTree(messages) }))
  }
  const emitter = (streamId: string, policy?: { updatePath: boolean }) => (event: any) => {
    for (const action of projectServerEvent(event, { streamId, conversationId: 'c' }))
      dispatch(policy ? applyStreamProjectionPolicy(action, { streamId, streamType: 'primary', updatePath: policy.updatePath }) : action)
  }
  const view = () => selectCurrentViewStreamFor(state.streaming, {
    conversationId: state.conversation.currentConversationId, lineageId: state.conversation.currentLineageId, path: state.conversation.currentPath,
  })?.id ?? null
  const tip = () => state.conversation.currentPath.at(-1) ?? null
  const pathTo = (id: string) => { const path: string[] = []; let at: any = id; while (at) { path.unshift(at); at = db.get(at)?.parent_id } return path }

  const streams: Record<string, { lineage: string; head: string; n: number; emit: (e: any) => void; done?: boolean }> = {}
  // One Claude API response: a turn boundary, then the same row persisted once per completed block.
  const step = (sid: string) => {
    const s = streams[sid]
    const id = `${sid}-a${++s.n}`
    for (let block = 0; block < 2; block++) {
      s.emit({ type: 'tool_loop', status: 'turn_started', turn: 1, maxTurns: 0 })
      s.emit({ type: 'assistant_message_persisted', message: row(id, s.head, 'assistant', s.lineage), lineageId: s.lineage })
    }
    s.head = id
    return id
  }
  const finish = (sid: string) => {
    const s = streams[sid]
    s.emit({ type: 'complete', message: row(s.head, db.get(s.head)!.parent_id as any, 'assistant', s.lineage), lineageId: s.lineage })
    dispatch(actions.sendingCompleted({ streamId: sid }))
    s.done = true
  }
  const begin = (sid: string, lineage: string, parent: string | null, emit: (e: any) => void) => {
    const u = `${sid}-u`
    streams[sid] = { lineage, head: u, n: 0, emit }
    row(u, parent, 'user', lineage)
    emit({ type: 'started', parentId: u, conversationId: 'c', lineageId: lineage })
    emit({ type: 'user_message_persisted', message: db.get(u), lineageId: lineage })
  }
  const send = (sid: string, lineage: string, parent: string, updatePath = true) => {
    dispatch(actions.sendingStarted({ streamId: sid, conversationId: 'c', streamType: updatePath ? 'primary' : 'branch', updatePath,
      selectionRevision: state.selection.revision, preserveDrafts: true,
      lineage: { lineageId: state.conversation.currentLineageId ?? undefined, rootMessageId: parent } }))
    begin(sid, lineage, parent, emitter(sid, { updatePath }))
  }
  // Mirrors editMessageWithBranching: a branch slot with no explicit updatePath, raw projection.
  const editBranch = (sid: string, sourceLineage: string | null, lineage: string, original: string) => {
    const parent = db.get(original)!.parent_id as string | null
    dispatch(actions.sendingStarted({ streamId: sid, conversationId: 'c', streamType: 'branch',
      selectionRevision: state.selection.revision, preserveDrafts: true,
      lineage: { lineageId: sourceLineage ?? undefined, originMessageId: original, rootMessageId: parent ?? undefined } }))
    begin(sid, lineage, parent, emitter(sid))
  }
  const selectNode = (id: string) => commitLocal(request({ kind: 'message', conversationId: 'c', messageId: id }))
  const leave = () => commitLocal(request({ kind: 'conversation', conversationId: 'd' }))
  const awayAndBack = (whileAway?: () => void) => {
    leave()
    whileAway?.()
    const back = request({ kind: 'conversation', conversationId: 'c' })
    snapshot()
    commitLocal(back)
  }
  // The agents pill opens `/lineage/:id`: the path is read from the host, then committed.
  const openLineage = (lineage: string, serverPath: string[], beforeCommit?: () => void) => {
    const requestId = request({ kind: 'lineage', conversationId: 'c', lineageId: lineage })
    snapshot()
    beforeCommit?.()
    dispatch(chatSelectionCommitted({ requestId, conversationId: 'c', lineageId: lineage, path: serverPath, focus: serverPath.at(-1) ?? null }))
  }

  commitLocal(request({ kind: 'conversation', conversationId: 'c' }))
  dispatch(actions.messageAdded(row('root', null, 'assistant', 'X')))
  dispatch(actions.conversationPathSet(['root']))
  return { get: () => state, dispatch, streams, step, finish, send, editBranch, selectNode, leave, awayAndBack, openLineage, snapshot, view, tip, pathTo, row, db }
}

describe('lineage-route return while a run streams', () => {
  it('adopts a row persisted between the host path read and the commit', () => {
    const w = world()
    w.send('S1', 'X', 'root'); w.step('S1')
    w.leave()
    const stale = w.pathTo(w.streams.S1.head)
    w.openLineage('X', stale, () => { w.step('S1') })
    expect(w.tip()).toBe(w.streams.S1.head)
    expect(w.view()).toBe('S1')
    w.step('S1'); w.step('S1')
    expect(w.tip()).toBe(w.streams.S1.head)
    w.finish('S1')
    expect(w.tip()).toBe(w.streams.S1.head)
  })

  it('adopts the final row of a run that finished during the unsettled navigation', () => {
    const w = world()
    w.send('S1', 'X', 'root'); w.step('S1')
    w.leave()
    const stale = w.pathTo(w.streams.S1.head)
    w.openLineage('X', stale, () => { w.step('S1'); w.finish('S1') })
    expect(w.tip()).toBe(w.streams.S1.head)
  })

  it('adopts rows persisted during an in-conversation switch back to the running branch', () => {
    const w = world()
    w.send('S1', 'X', 'root'); w.step('S1')
    w.editBranch('S2', 'X', 'Y', 'S1-u'); w.step('S2')
    expect(w.tip()).toBe(w.streams.S2.head)
    // Back to S1's branch: its path is stale by the row that lands before the commit.
    const stale = w.pathTo(w.streams.S1.head)
    w.openLineage('X', stale, () => { w.step('S1') })
    expect(w.tip()).toBe(w.streams.S1.head)
    expect(w.view()).toBe('S1')
    w.step('S2')
    expect(w.tip()).toBe(w.streams.S1.head)
  })
})

describe('row-time catch-up', () => {
  it('heals a view that trails the run by a missed row', () => {
    const w = world()
    w.send('S1', 'X', 'root'); w.step('S1')
    const stale = w.pathTo(w.streams.S1.head)
    w.step('S1')
    // A different view first, so the run is no longer the selection owner.
    w.dispatch(actions.messageAdded(w.row('sibling', 'root', 'assistant', 'Z')))
    w.selectNode('sibling')
    // A stale path hint (Heimdall's tree can lag the live head) stops one row short.
    const requestId = 'hint'
    w.dispatch(chatSelectionRequested({ requestId, target: { kind: 'message', conversationId: 'c', messageId: stale.at(-1)!, path: stale }, source: 'heimdall' }))
    w.dispatch(chatSelectionCommitted({ requestId, conversationId: 'c', lineageId: null, path: stale, focus: stale.at(-1)! }))
    // The commit itself reconciles against the live run.
    expect(w.tip()).toBe(w.streams.S1.head)
    expect(w.view()).toBe('S1')
  })

  it('catches up on the next row when nothing reconciled at commit', () => {
    const w = world()
    w.send('S1', 'X', 'root'); w.step('S1')
    const stale = w.pathTo(w.streams.S1.head)
    w.step('S1')
    w.dispatch(actions.messageAdded(w.row('sibling', 'root', 'assistant', 'Z')))
    w.selectNode('sibling')
    // Legacy path writes bypass selection commits entirely.
    w.dispatch(actions.conversationPathSet(stale))
    expect(w.tip()).toBe(stale.at(-1))
    w.step('S1')
    expect(w.tip()).toBe(w.streams.S1.head)
    expect(w.view()).toBe('S1')
    w.finish('S1')
    expect(w.tip()).toBe(w.streams.S1.head)
  })

  it('shows the final row when only the terminal frames arrive after the gap', () => {
    const w = world()
    w.send('S1', 'X', 'root'); w.step('S1')
    const stale = w.pathTo(w.streams.S1.head)
    w.step('S1')
    w.dispatch(actions.messageAdded(w.row('sibling', 'root', 'assistant', 'Z')))
    w.selectNode('sibling')
    w.dispatch(actions.conversationPathSet(stale))
    w.finish('S1')
    expect(w.tip()).toBe(w.streams.S1.head)
  })

  it('never crosses to a sibling, a foreign lineage or a parallel pane run', () => {
    const w = world()
    w.send('S1', 'X', 'root'); w.step('S1')
    w.dispatch(actions.messageAdded(w.row('sibling', 'root', 'assistant', 'Z')))
    w.selectNode('sibling')
    w.step('S1'); w.step('S1')
    expect(w.tip()).toBe('sibling')

    // A child fork below the selected lineage's head belongs to another confirmed lineage.
    const head = w.streams.S1.head
    w.finish('S1')
    w.openLineage('X', w.pathTo(head))
    w.send('fork', 'Y', head, false)
    w.step('fork'); w.step('fork')
    expect(w.tip()).toBe(head)
    w.snapshot()
    expect(w.tip()).toBe(head)

    // Parallel pane runs (updatePath:false) stay isolated even with no lineage selected.
    const requestId = 'no-lineage'
    w.dispatch(chatSelectionRequested({ requestId, target: { kind: 'message', conversationId: 'c', messageId: head, path: w.pathTo(head) }, source: 'heimdall' }))
    w.dispatch(chatSelectionCommitted({ requestId, conversationId: 'c', lineageId: null, path: w.pathTo(head), focus: head }))
    expect(w.tip()).toBe(head)
    w.send('pane', 'X', head, false)
    w.step('pane')
    w.snapshot()
    expect(w.tip()).toBe(head)
  })

  it('does not replay a finished run into a view selected after it ended', () => {
    const w = world()
    w.send('S1', 'X', 'root'); w.step('S1')
    const earlier = w.pathTo(w.streams.S1.head)
    w.step('S1'); w.finish('S1')
    const requestId = 'later'
    w.dispatch(chatSelectionRequested({ requestId, target: { kind: 'message', conversationId: 'c', messageId: earlier.at(-1)!, path: earlier }, source: 'test' }))
    w.dispatch(chatSelectionCommitted({ requestId, conversationId: 'c', lineageId: null, path: earlier, focus: earlier.at(-1)! }))
    w.snapshot()
    expect(w.tip()).toBe(earlier.at(-1))
  })
})

describe('a run held open by a background task', () => {
  // The task's progress is written on the call that launched it, so the host persists that
  // earlier row again, about once a second, while the run's head stays where the turn ended.
  const waiting = () => {
    const w = world()
    w.send('S1', 'X', 'root')
    const launch = w.step('S1'); w.step('S1'); w.step('S1')
    const progress = () => w.streams.S1.emit({ type: 'assistant_message_persisted',
      message: w.row(launch, 'S1-u', 'assistant', 'X'), lineageId: 'X' })
    return { w, launch, progress, head: w.streams.S1.head }
  }

  it('stays the view stream after another chat was opened while the task reported progress', () => {
    const { w, progress, head } = waiting()
    w.awayAndBack(() => { progress(); progress() })
    expect(w.tip()).toBe(head)
    expect(w.view()).toBe('S1')
    expect(w.get().conversation.currentLineageId).toBe('X')
    progress()
    expect(w.view()).toBe('S1')
    expect(w.tip()).toBe(head)
  })

  it('keeps the run anchored at its head, not at the launching call', () => {
    const { w, progress, head } = waiting()
    progress()
    const stream = w.get().streaming.byId.S1
    expect(stream.currentBranchAnchorMessageId).toBe(head)
    expect(stream.lastCompletedMessageId).toBe(head)
    expect(stream.persistedTurnMessageId).toBe(head)
    expect(w.tip()).toBe(head)
  })

  it('shows the turn that answers the finished task', () => {
    const { w, progress } = waiting()
    w.awayAndBack(progress)
    progress()
    const answer = w.step('S1')
    expect(w.tip()).toBe(answer)
    expect(w.view()).toBe('S1')
    progress()
    w.finish('S1')
    expect(w.tip()).toBe(answer)
  })

  it('still follows the head when that row itself is persisted again', () => {
    const { w, head } = waiting()
    // A sibling run branched from the head, so the head now has a child of its own.
    w.row('other', head, 'user', 'Y')
    w.streams.S1.emit({ type: 'assistant_message_persisted', message: w.row(head, w.db.get(head)!.parent_id as string, 'assistant', 'X'), lineageId: 'X' })
    expect(w.get().streaming.byId.S1.currentBranchAnchorMessageId).toBe(head)
    const next = w.step('S1')
    expect(w.tip()).toBe(next)
    expect(w.view()).toBe('S1')
  })
})

describe('returning to a run that is already on screen at its head', () => {
  it('selects the run\'s lineage with the view, before any further row arrives', () => {
    const w = world()
    w.send('S1', 'X', 'root'); w.step('S1')
    w.awayAndBack(() => { w.step('S1') })
    expect(w.tip()).toBe(w.streams.S1.head)
    expect(w.get().conversation.currentLineageId).toBe('X')
    expect(w.view()).toBe('S1')
  })

  it('does not take a lineage from a run whose head is elsewhere', () => {
    const w = world()
    w.send('S1', 'X', 'root'); w.step('S1')
    const earlier = w.streams.S1.head
    w.step('S1')
    w.leave()
    const requestId = 'explicit'
    w.dispatch(chatSelectionRequested({ requestId, target: { kind: 'conversation', conversationId: 'c' }, source: 'route' }))
    w.snapshot()
    // A view that stops one row short of the head is caught up; this one is on a sibling.
    w.row('side', earlier, 'user', 'Y')
    w.snapshot()
    w.dispatch(chatSelectionCommitted({ requestId, conversationId: 'c', lineageId: null, path: [...w.pathTo(earlier), 'side'], focus: null }))
    expect(w.tip()).toBe('side')
    expect(w.get().conversation.currentLineageId).toBeNull()
  })
})

describe('rebootstrap of an edit-branch run', () => {
  it('keeps following its own view, through to the final row', () => {
    const w = world()
    w.send('S1', 'X', 'root'); w.step('S1'); w.finish('S1')
    w.editBranch('S2', 'X', 'Y', 'S1-u'); w.step('S2')
    expect(w.get().streaming.byId.S2.updatePath).toBeUndefined()
    w.dispatch(actions.streamBootstrapReset({ streamId: 'S2', conversationId: 'c' }))
    w.streams.S2.emit({ type: 'started', parentId: 'S2-u', conversationId: 'c', lineageId: 'Y' })
    w.dispatch(actions.streamBootstrapReconciled({ streamId: 'S2', messageIds: ['S2-u', 'S2-a1'] }))
    expect(w.get().streaming.byId.S2.updatePath).toBeUndefined()
    w.step('S2'); w.step('S2')
    expect(w.tip()).toBe(w.streams.S2.head)
    w.finish('S2')
    expect(w.tip()).toBe(w.streams.S2.head)
  })

  it('still treats an unknown slot as a passive observer', () => {
    const w = world()
    w.dispatch(actions.streamBootstrapReset({ streamId: 'unknown', conversationId: 'c' }))
    expect(w.get().streaming.byId.unknown.updatePath).toBe(false)
  })
})

describe('stateReset (conversation list page) while a run streams', () => {
  it('keeps the run slot so returning to the chat shows and follows it', () => {
    const w = world()
    w.send('S1', 'X', 'root'); w.step('S1')
    const revision = w.get().selection.revision
    w.dispatch(actions.stateReset())
    const slot = w.get().streaming.byId.S1
    expect(slot?.active).toBe(true)
    expect(w.get().streaming.activeIds).toEqual(['S1'])
    expect(w.get().selection.revision).toBeGreaterThan(revision)
    expect(w.get().conversation.messages).toEqual([])
    w.step('S1')
    expect(w.get().conversation.currentPath).toEqual([])

    w.dispatch(actions.conversationSet('c'))
    const back = 'back'
    w.dispatch(chatSelectionRequested({ requestId: back, target: { kind: 'conversation', conversationId: 'c' }, source: 'route' }))
    w.snapshot()
    const c = w.get().conversation
    const resolved = resolveLocalChatSelection(w.get().selection.target!, c.messages,
      { conversationId: 'c', lineageId: c.currentLineageId, path: c.currentPath, focus: null })!
    w.dispatch(chatSelectionCommitted({ ...resolved, requestId: back }))
    expect(w.tip()).toBe(w.streams.S1.head)
    expect(w.view()).toBe('S1')
    w.step('S1')
    expect(w.tip()).toBe(w.streams.S1.head)
    w.finish('S1')
    expect(w.tip()).toBe(w.streams.S1.head)
  })
})

describe('returning to a conversation with parallel forks', () => {
  it('reopens the branch that was on screen, at its live head, not the fork with the newest row', () => {
    const w = world()
    w.send('S1', 'X', 'root'); w.step('S1')
    w.editBranch('S2', 'X', 'Y', 'S1-u'); w.step('S2')
    w.selectNode(w.streams.S1.head)
    expect(w.tip()).toBe(w.streams.S1.head)
    w.leave()
    w.step('S1'); w.step('S2') // S2 now holds the newest row
    const back = 'back'
    w.dispatch(chatSelectionRequested({ requestId: back, target: { kind: 'conversation', conversationId: 'c' }, source: 'route' }))
    w.snapshot()
    const c = w.get().conversation
    w.dispatch(chatSelectionCommitted({ requestId: back, ...resolveLocalChatSelection(w.get().selection.target!, c.messages,
      { conversationId: 'c', lineageId: null, path: c.currentPath, focus: null }, c.lastViewedTips?.c)! }))
    expect(w.tip()).toBe(w.streams.S1.head)
    expect(w.view()).toBe('S1')
    w.step('S1')
    expect(w.tip()).toBe(w.streams.S1.head)
  })

  it('falls back to the newest row when the remembered tip no longer exists', () => {
    const w = world()
    w.send('S1', 'X', 'root'); w.step('S1')
    const rows = w.get().conversation.messages
    const resolved = resolveLocalChatSelection({ kind: 'conversation', conversationId: 'c' }, rows,
      { conversationId: 'c', lineageId: null, path: [], focus: null }, 'deleted')!
    expect(resolved.path.at(-1)).toBe(w.streams.S1.head)
  })

  it('bounds the remembered views', () => {
    const w = world()
    for (let i = 0; i < 130; i++) {
      w.dispatch(actions.conversationSet(`k${i}`))
      w.dispatch(actions.conversationPathSet([`tip${i}`]))
    }
    w.dispatch(actions.conversationSet('end'))
    const tips = w.get().conversation.lastViewedTips!
    expect(Object.keys(tips)).toHaveLength(100)
    expect(tips.k129).toBe('tip129')
    expect(tips.k0).toBeUndefined()
  })
})

describe('parallel forks in one conversation (fuzz)', () => {
  it('a run always extends the view that shows its head, and no view is pulled elsewhere', () => {
    let seed = 7
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n }
    const failures: string[] = []
    for (let run = 0; run < 300 && failures.length < 3; run++) {
      const w = world(); const trace: string[] = []
      const checkedStep = (sid: string) => {
        const before = w.tip()
        const watching = before === w.streams[sid].head
        const id = w.step(sid)
        trace.push(`step ${sid} -> ${id} tip=${w.tip()} view=${w.view()}`)
        if (watching && (w.tip() !== id || w.view() !== sid)) throw new Error(`stranded ${sid}`)
        if (!watching && w.tip() !== before && !w.pathTo(id).includes(before as string)) throw new Error(`pulled to ${sid}`)
      }
      try {
        w.send('S1', 'X', 'root'); checkedStep('S1')
        w.editBranch('S2', 'X', 'Y', 'S1-u'); trace.push('editBranch S2')
        for (let i = 0; i < 16; i++) {
          const op = rnd(11)
          const live = Object.keys(w.streams).filter(id => !w.streams[id].done)
          if (op < 6 && live.length) checkedStep(live[rnd(live.length)])
          else if (op === 6) { const sid = ['S1', 'S2'][rnd(2)]; w.selectNode(w.streams[sid].head); trace.push(`select ${sid}`) }
          else if (op === 7) { w.awayAndBack(); trace.push(`awayAndBack tip=${w.tip()}`) }
          else if (op === 8) { w.snapshot(); trace.push('snapshot') }
          else if (op === 9 && live.length) {
            // Pill "Open chat": a host path that is one row stale by the time it commits.
            const sid = live[rnd(live.length)]
            const stale = w.pathTo(w.streams[sid].head)
            w.openLineage(w.streams[sid].lineage, stale, () => { w.step(sid) })
            trace.push(`openLineage ${sid} tip=${w.tip()}`)
            if (w.tip() !== w.streams[sid].head || w.view() !== sid) throw new Error(`stale lineage commit stranded ${sid}`)
          } else if (op === 10 && live.length > 1) {
            const sid = live[rnd(live.length)]
            const watching = w.tip() === w.streams[sid].head
            w.finish(sid); trace.push(`finish ${sid} tip=${w.tip()}`)
            if (watching && w.tip() !== w.streams[sid].head) throw new Error(`final lost ${sid}`)
          }
        }
      } catch (error) { failures.push(`run ${run}: ${(error as Error).message}\n${trace.join('\n')}`) }
    }
    expect(failures).toEqual([])
  })
})
