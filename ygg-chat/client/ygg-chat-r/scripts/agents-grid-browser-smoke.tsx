import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { AgentsMonitorGrid } from '../src/components/RunningAgentsFloatingButton/AgentsMonitorGrid'
import { createEmptyStreamState } from '../src/features/chats/streamHelpers'
import type { AgentRunPreviewState } from '../src/features/chats/agentRunPreviewSlice'
import type { AgentStreamListItem } from '../src/hooks/useRunningAgentStreams'

const previews: AgentRunPreviewState = { byStreamId: {}, latestByFork: {} }
const streams = Array.from({ length: 120 }, (_, index): AgentStreamListItem => {
  const streamId = `run-${index}`
  const stream = { ...createEmptyStreamState('branch'), active: true, conversationId: 'chat',
    createdAt: new Date(Date.UTC(2026, 9, 10, 0, 0, 120 - index)).toISOString(),
    lineage: { lineageId: `fork-${index}`, lineageIdConfirmed: true }, buffer: `Transcript ${streamId}` }
  previews.byStreamId[streamId] = { streamId, stream, entries: [{ key: streamId, stream }],
    turn: 0, liveKey: streamId, partial: false, completedAt: null, projectId: null, conversationTitle: 'Fixture' }
  return { streamId, streamType: 'branch', conversationId: 'chat', projectId: null, conversationTitle: `Chat ${index}`,
    lineageId: `fork-${index}`, lineageIdConfirmed: true, anchorMessageId: null, hasError: false,
    createdAt: stream.createdAt, status: 'active', triggerUserMessageId: null, currentBranchAnchorMessageId: null,
    branchAnchorMessageId: null, liveMessageId: null, streamingMessageId: null, lastCompletedMessageId: null,
    finalMessageId: null, messageId: null, originMessageId: null, rootMessageId: null, parentMessageId: null,
    parentMessageText: null, activityKind: 'text', activityLabel: 'Writing', completedAt: null, displayName: streamId }
})
const store = configureStore({ reducer: (state = { agentRunPreviews: previews }, action) => {
  if (action.type !== 'fixture/update') return state
  const streamId = action.payload as string
  const run = state.agentRunPreviews.byStreamId[streamId]
  const stream = { ...run.stream, buffer: `${run.stream.buffer}!` }
  return { agentRunPreviews: { ...state.agentRunPreviews, byStreamId: { ...state.agentRunPreviews.byStreamId,
    [streamId]: { ...run, stream, entries: [{ key: streamId, stream }] } } } }
} })
const history: AgentStreamListItem[] = []
let toggle: () => void
let refresh: () => void
function Fixture() {
  const [open, setOpen] = useState(true)
  const [items, setItems] = useState(streams)
  toggle = () => setOpen(value => !value)
  refresh = () => setItems(previous => [...previous])
  return <Provider store={store}><div style={{ width: 1100, height: 600, display: 'flex', flexDirection: 'column' }}>
    {open && <AgentsMonitorGrid activeStreams={items} streamHistory={history} grouped={false} onOpenFork={() => {}} onOpenChat={() => {}} />}
  </div></Provider>
}
const root = createRoot(document.getElementById('root')!)
flushSync(() => root.render(<StrictMode><Fixture /></StrictMode>))
const wait = (ms = 80) => new Promise(resolve => setTimeout(resolve, ms))
const check = (condition: unknown, message: string) => { if (!condition) throw new Error(message) }
const transcripts = () => document.querySelectorAll('[data-fixture-message]')
const scroller = () => document.querySelector('[aria-label="Agent forks"] > div') as HTMLElement

;(window as any).__runAgentsGridSmoke = async () => {
  const results: string[] = []
  await wait(250)
  check(document.querySelectorAll('[aria-label^="Preview Chat"]').length === 120, 'All card headers must remain accessible')
  check(transcripts().length > 0 && transcripts().length <= 9, `Expected bounded initial transcript mounts, got ${transcripts().length}`)
  check(document.body.textContent?.includes('Transcript run-0'), 'First transcript must load')
  check(!document.body.textContent?.includes('Transcript run-119'), 'Offscreen transcript mounted eagerly')
  results.push(`120 forks: only ${transcripts().length} initial transcripts mounted`)

  const first = document.querySelector('[data-fixture-message]')
  const initialRenders = (window as any).__messageRenders
  flushSync(() => refresh())
  await wait()
  check((window as any).__messageRenders === initialRenders, 'Parent metadata rerender rebuilt unchanged transcripts')
  flushSync(() => store.dispatch({ type: 'fixture/update', payload: 'run-119' }))
  await wait()
  check((window as any).__messageRenders === initialRenders, 'Unrelated update rerendered visible transcripts')
  check(document.querySelector('[data-fixture-message]') === first, 'Unrelated update remounted the first transcript')
  flushSync(() => store.dispatch({ type: 'fixture/update', payload: 'run-0' }))
  await wait()
  check(document.body.textContent?.includes('Transcript run-0!'), 'Visible stream update was lost')
  results.push('Offscreen stream updates do not rerender visible transcripts; visible updates still render')

  const transcript = document.querySelector('[aria-label$="transcript"]') as HTMLElement
  transcript.scrollTop = 150
  transcript.dispatchEvent(new Event('scroll'))
  transcript.focus()
  await wait()
  check(document.activeElement === transcript, `Fixture failed to focus transcript: ${document.activeElement?.outerHTML.slice(0, 200)}`)
  scroller().scrollTop = scroller().scrollHeight
  await wait(250)
  check(document.activeElement === transcript, `Focused transcript was unmounted when scrolled away: connected=${transcript.isConnected}, active=${document.activeElement?.outerHTML.slice(0, 180)}`)
  transcript.blur()
  await wait(250)
  check(document.body.textContent?.includes('Transcript run-119!'), 'Scrolling did not mount the updated last transcript')
  check(!document.body.textContent?.includes('Transcript run-0!'), 'Scrolled-away transcript stayed mounted')
  check(transcripts().length <= 9, 'Mounted transcripts grew with visited rows')
  scroller().scrollTop = 0
  await wait(250)
  check(document.body.textContent?.includes('Transcript run-0!'), 'Scrolling back did not restore retained transcript')
  check((document.querySelector('[aria-label$="transcript"]') as HTMLElement).scrollTop === 150, 'Reading position was lost on remount')
  check(document.body.textContent?.includes('Jump to latest'), 'Paused auto-follow was lost on remount')
  results.push('Focused offscreen transcript stays mounted; paused reading position survives unmount/remount')
  results.push('Scroll to the end and back keeps transcript mounts bounded and retained output intact')

  const shell = scroller().parentElement!.parentElement!
  shell.style.width = '500px'
  await wait(250)
  check(document.querySelectorAll('[role="separator"]').length === 0, 'Narrow grid must become single-column')
  check(document.body.textContent?.includes('Transcript run-0!'), 'Responsive resize lost visible transcript')
  results.push('Responsive column change remeasures visibility')

  flushSync(() => toggle())
  check(transcripts().length === 0, 'Collapse did not release transcript mounts')
  flushSync(() => toggle())
  await wait(250)
  check(document.body.textContent?.includes('Transcript run-0!'), 'Reopen lost retained output')
  check(transcripts().length <= 9, 'Reopen eagerly mounted all transcripts')
  results.push('StrictMode collapse/reopen defers transcripts again')
  return results
}
