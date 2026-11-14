import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ContentBlock, HookRunRecord, StreamEvent } from '../../features/chats/chatTypes'
import { AgentSteps } from './AgentSteps'
import { getAgentProgress, partitionAgentItems, splitLiveAgentEvents, hasTrailingAgentProse, canAttachLiveAgentGroup, buildStreamRenderItems, trailingAgentGroupKey, resolveActivityIndicatorOwner, resolveTrailingStatusGroupKey, type ActivityItem } from './agentActivity'
import { estimateMessageRowHeight } from './estimateMessageHeight'

const item = (key: string, kind: ActivityItem['kind']): ActivityItem => ({ key, kind })
const call = (id: string, name = 'read_file'): StreamEvent => ({ type: 'tool_call', toolCall: { id, name, arguments: {}, status: 'executing' } })
const result = (id: string): StreamEvent => ({ type: 'tool_result', toolResult: { tool_use_id: id, content: 'ok', is_error: false } })
const tool = (id: string): ContentBlock => ({ type: 'tool_use', id, name: 'read_file', input: {}, index: 0 })
const context: ContentBlock = { type: 'context_injection', path: 'docs/rule.md', label: 'Rule', text: 'instructions', reason: 'path_glob_match' }

describe('continuing agent history', () => {
  it('keeps the same key as context, skills, hooks, and later tools append', () => {
    const sequence = [item('tool-1', 'process'), item('rule', 'activity'), item('tool-2', 'process'), item('skill', 'activity'), item('hook', 'activity'), item('tool-3', 'process')]
    for (let length = 1; length <= sequence.length; length++) {
      const groups = partitionAgentItems(sequence.slice(0, length))
      expect(groups).toHaveLength(1)
      expect(groups[0].key).toBe('tool-1')
    }
    expect(partitionAgentItems(sequence)[0]).toMatchObject({ history: [sequence[0], sequence[2], sequence[5]], activity: [sequence[1], sequence[3], sequence[4]] })
  })
  it('keeps prose, errors and interactive surfaces outside the group', () => {
    const groups = partitionAgentItems([item('a', 'process'), item('rule', 'activity'), item('answer', 'other'), item('error', 'other'), item('html', 'other'), item('b', 'process')])
    expect(groups.map(group => group.key)).toEqual(['a', 'answer', 'error', 'html', 'b'])
  })
  it('does not swallow short final answers or standalone context', () => {
    expect(partitionAgentItems([item('rule', 'activity')])).toEqual([item('rule', 'activity')])
    const answer = { ...item('answer', 'other'), ignoreForProcessRunGrouping: true }
    expect(partitionAgentItems([item('a', 'process'), answer]).map(part => part.key)).toEqual(['a', 'answer'])
  })
  it('keeps short final prose outside even when context follows it', () => {
    const answer = { ...item('answer', 'other'), ignoreForProcessRunGrouping: true }
    expect(partitionAgentItems([item('a', 'process'), answer, item('rule', 'activity')]).map(part => part.key)).toEqual(['a', 'answer', 'rule'])
    expect(hasTrailingAgentProse([tool('a'), { type: 'text', content: 'Done.', index: 1 }, context])).toBe(true)
    expect(hasTrailingAgentProse([{ type: 'text', content: 'Inspecting.', index: 0 }, tool('a'), context])).toBe(false)
  })
  it('retains leading annotations inside a run without swallowing trailing prose', () => {
    const annotation = { ...item('note', 'other'), ignoreForProcessRunGrouping: true }
    expect(partitionAgentItems([annotation, item('a', 'process')])).toHaveLength(1)
  })
})

describe('live projection ownership', () => {
  it('attaches only to the trailing group of this active run, never across boundaries', () => {
    const input = { enabled: true, active: true, compacting: false, optimistic: false, trailing: { kind: 'process_group', memberMessageIds: ['a', 'b'] }, anchor: 'b', boundaryAfter: false }
    expect(canAttachLiveAgentGroup(input)).toBe(true)
    expect(canAttachLiveAgentGroup({ ...input, anchor: 'other-branch' })).toBe(false)
    expect(canAttachLiveAgentGroup({ ...input, boundaryAfter: true })).toBe(false)
    expect(canAttachLiveAgentGroup({ ...input, optimistic: true })).toBe(false)
    expect(canAttachLiveAgentGroup({ ...input, compacting: true })).toBe(false)
    expect(canAttachLiveAgentGroup({ ...input, active: false })).toBe(false)
    expect(canAttachLiveAgentGroup({ ...input, enabled: false })).toBe(false)
    expect(canAttachLiveAgentGroup({ ...input, trailing: { kind: 'message' } })).toBe(false)
  })
  it('splits live history from final text without duplicating events', () => {
    const events: StreamEvent[] = [call('a'), result('a'), call('b'), result('b'), { type: 'text', delta: 'Done.' }]
    const split = splitLiveAgentEvents(events)
    expect(split.process).toEqual(events.slice(0, 4))
    expect(split.outside).toEqual(events.slice(4))
  })
  it.each(['html_renderer', 'mcp__app'])('keeps %s visible outside', name => {
    const events = [call('a'), result('a'), call('app', name), result('app')]
    const split = splitLiveAgentEvents(events)
    expect(split.process).toEqual(events.slice(0, 2))
    expect(split.outside).toEqual(events.slice(2))
  })
  it('keeps errors outside, including ones followed by a tool result', () => {
    const events: StreamEvent[] = [call('a'), { type: 'error' }, result('a')]
    expect(splitLiveAgentEvents(events)).toEqual({ process: [events[0], events[2]], outside: [events[1]] })
  })
  it('does not count a persisted tool twice when transient results are retained', () => {
    expect(getAgentProgress([tool('a')], [call('a'), result('a')])).toMatchObject({ toolCount: 1, completed: 1, pending: 0 })
  })
  it('continues counts for subsequent turns and prioritizes active hooks', () => {
    const blocks: ContentBlock[] = [tool('a'), { type: 'tool_result', tool_use_id: 'a', content: '', index: 1, is_error: false }]
    const hooks = [{ event: 'PreToolUse', label: 'Edit policy', status: 'running' }] as HookRunRecord[]
    expect(getAgentProgress(blocks, [call('b')], hooks, true)).toMatchObject({ toolCount: 2, completed: 1, pending: 1, status: 'PreToolUse · Edit policy', active: true })
  })
  it('does not label the finished run as failed when individual tools failed', () => {
    const blocks: ContentBlock[] = [tool('a'), { type: 'tool_result', tool_use_id: 'a', content: 'Not found', index: 1, is_error: true }]
    expect(getAgentProgress(blocks)).toMatchObject({ completed: 1, hasFailure: true, active: false, status: undefined })
    expect(getAgentProgress(blocks, [], [], true).status).toBe('Continuing agent work')
  })
  it('does not claim a stopped incomplete tool is running', () => {
    expect(getAgentProgress([tool('a')], [], [], false)).toMatchObject({ active: false, status: undefined, pending: 1 })
  })
})

describe('attached activity rendering', () => {
  it('uses the shared thinking words for generic live status', () => {
    const html = renderToStaticMarkup(<AgentSteps id='run' expanded={false} onToggle={() => {}} history={null} status='Continuing agent work' active />)
    expect(html).toContain('Thinking')
    expect(html).not.toContain('Continuing agent work')
    expect(html).toContain('aria-label="Assistant is working"')
  })
  it('keeps attachments and progress outside the closed history', () => {
    const html = renderToStaticMarkup(<AgentSteps id='run' expanded={false} onToggle={() => {}} summary='2 completed'
      history={<div>Hidden tool output</div>} activity={<div>Path rule matched</div>} status='PreToolUse · Edit policy' active />)
    expect(html).toContain('Path rule matched')
    expect(html).toContain('PreToolUse · Edit policy')
    expect(html).not.toContain('Hidden tool output')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('leading-tight')
  })
  it('keeps counts and attachments visible when expanded', () => {
    const html = renderToStaticMarkup(<AgentSteps id='run' expanded onToggle={() => {}} summary='2 completed' history={<div>Tool history</div>} activity={<div>Hook passed</div>} />)
    expect(html).toContain('2 completed')
    expect(html).toContain('Tool history')
    expect(html).toContain('Hook passed')
    expect(html.match(/data-agent-steps/g)).toHaveLength(1)
  })
  it('estimates attached context without adding a second group header', () => {
    const estimate = (blocks: ContentBlock[]) => estimateMessageRowHeight({ role: 'assistant', content: '', contentBlocks: blocks, containerWidth: 720, rootFontSize: 16, fontSizeOffset: 0, groupToolReasoningRuns: true, artifactCount: 0, showsActionsRow: false })
    expect(estimate([tool('a'), context, tool('b')])).toBe(estimate([tool('a'), context]))
    expect(estimate([tool('a'), context])).toBeGreaterThan(estimate([tool('a')]))
  })
})

describe('activity indicator ownership', () => {
  const text = (delta = 'Still working.'): StreamEvent => ({ type: 'text', delta })
  const reasoning: StreamEvent = { type: 'reasoning', delta: 'Thinking' }
  const owner = (events: StreamEvent[], overrides: Partial<Parameters<typeof resolveActivityIndicatorOwner>[0]> = {}, grouped = true) =>
    resolveActivityIndicatorOwner({ visible: true, placement: 'message', dedicatedStatus: false,
      liveTail: events.some(event => event.type === 'text' && event.delta?.trim()),
      trailingGroupKey: trailingAgentGroupKey(buildStreamRenderItems(events), grouped), ...overrides })

  it('moves the single owner through reasoning, commentary, tools, commentary and completion', () => {
    const events: StreamEvent[] = []
    expect(owner(events)).toEqual({ kind: 'virtual-footer' })
    events.push(reasoning)
    expect(owner(events).kind).toBe('agent-steps')
    events.push(text())
    expect(owner(events)).toEqual({ kind: 'live-tail' })
    events.push(call('a'))
    expect(owner(events).kind).toBe('agent-steps')
    events.push(text('Found the cause.'))
    expect(owner(events)).toEqual({ kind: 'live-tail' })
    expect(owner(events, { visible: false })).toEqual({ kind: 'none' })
  })

  it('does not mistake text events or an earlier process group for an active trailing group', () => {
    expect(owner([text()])).toEqual({ kind: 'live-tail' })
    expect(owner([reasoning, text()])).toEqual({ kind: 'live-tail' })
    expect(owner([call('a'), text(), result('a')])).toEqual({ kind: 'live-tail' })
    expect(owner([call('a'), text(), result('unknown')])).toEqual({ kind: 'live-tail' })
    expect(buildStreamRenderItems([call('a'), text(), result('a')]).map(item => item.source)).toEqual(['tool', 'text'])
  })

  it('uses the shared renderer grouping rules for short text, whitespace and split deltas', () => {
    expect(owner([text('Inspecting'), text(' files.'), call('a')]).kind).toBe('agent-steps')
    expect(owner([call('a'), text('OK')]).kind).toBe('live-tail')
    const items = buildStreamRenderItems([reasoning, text(' '), { ...reasoning, delta: ' more' }])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ source: 'reasoning', text: 'Thinking more' })
    expect(owner([text('')])).toEqual({ kind: 'virtual-footer' })
  })

  it.each(['html_renderer', 'mcp__app'])('keeps the footer after an interactive %s surface', name => {
    expect(owner([call('a'), call('surface', name), result('surface')])).toEqual({ kind: 'virtual-footer' })
  })

  it('keeps image, notice and visible error boundaries outside group ownership', () => {
    for (const event of [
      { type: 'image', url: 'data:image/png;base64,AA' },
      { type: 'notice', content: 'Reconnecting' },
      { type: 'error', errorEnvelope: { code: 'unknown' } },
    ] as StreamEvent[]) {
      expect(owner([call('a'), event])).toEqual({ kind: 'virtual-footer' })
    }
  })

  it('preserves input placement, compaction/background statuses and disabled grouping', () => {
    expect(owner([reasoning], { placement: 'input-tab' })).toEqual({ kind: 'input-tab' })
    expect(owner([reasoning], { dedicatedStatus: true })).toEqual({ kind: 'virtual-footer' })
    expect(owner([text(), call('a')], { dedicatedStatus: true })).toEqual({ kind: 'live-tail' })
    expect(owner([reasoning], {}, false)).toEqual({ kind: 'virtual-footer' })
    expect(owner([text(), call('a')], {}, false)).toEqual({ kind: 'live-tail' })
    expect(owner([reasoning], { visible: false, placement: 'input-tab' })).toEqual({ kind: 'none' })
  })

  it('only lets the persisted group own activity when visible live content does not follow it', () => {
    const split = splitLiveAgentEvents([call('a'), text(), result('a')])
    const outside = buildStreamRenderItems(split.outside)
    expect(outside).toHaveLength(1)
    expect(trailingAgentGroupKey(outside, true)).toBeNull()
    expect(owner(split.outside)).toEqual({ kind: 'live-tail' })
    expect(owner([], { trailingGroupKey: 'persisted:a' })).toEqual({ kind: 'agent-steps', groupKey: 'persisted:a' })
  })
})

describe('trailing surface selection', () => {
  const resolve = (events: StreamEvent[], extra = {}) => resolveTrailingStatusGroupKey({
    items: buildStreamRenderItems(events), grouped: true, standalone: true, streamingMessage: true, attachedGroupId: 'persisted', ...extra,
  })
  it('uses persisted ownership across turn reset, invisible events and persistence handoff', () => {
    expect(resolve([])).toBe('persisted:persisted')
    expect(resolve([{ type: 'notice', content: '' }, { type: 'error' }])).toBe('persisted:persisted')
    expect(resolve([{ type: 'text', delta: 'Already persisted' }], { standalone: false, streamingMessage: false })).toBe('persisted:persisted')
    expect(resolve([], { attachedGroupId: null })).toBeNull()
  })
  it('does not let a previous group claim visible prose, and selects only the last of two live groups', () => {
    const prose: StreamEvent = { type: 'text', delta: 'This is substantive commentary that remains visible outside the process group and explains the next step.' }
    expect(resolve([prose])).toBeNull()
    expect(resolve([call('a'), prose, call('b')])).toBe('live:stream-tool-b-2')
    expect(resolve([call('a'), prose, call('b')], { grouped: false, attachedGroupId: null })).toBeNull()
  })
})
