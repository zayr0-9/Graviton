import { describe, expect, it } from 'vitest'
import type { ContentBlock, Message } from '../../features/chats/chatTypes'
import { buildConversationTree } from '../../features/chats/conversationTree'
import { getIntermediateAgentTextIds, hasHeimdallTextContent } from './heimdallAgentTextVisibility'
import { shouldPromoteHeimdallNode } from './heimdallNodeVisibility'
import { filterChatTree, walkChatTree } from './heimdallTreeTraversal'
import { expandHeimdallSelectionToBranchMessages } from './heimdallSelection'

const row = (id: string, parent_id: string | null, content = '', overrides: Partial<Message> = {}): Message => ({
  id, parent_id, content, conversation_id: 'conversation', role: 'assistant', children_ids: [],
  content_plain_text: content, created_at: '2026-10-27T00:00:00Z', model_name: 'test', partial: false,
  pastedContext: [], artifacts: [], meta: { runStatistics: { version: 1, streamId: 'run', kind: 'model_response' } },
  ...overrides,
})
const thinking: ContentBlock[] = [{ type: 'thinking', content: 'Thinking', index: 0 }]
const tools: ContentBlock[] = [{ type: 'tool_use', id: 'call', name: 'read_file', input: {}, index: 0 }]
const classify = (messages: Message[]) => getIntermediateAgentTextIds(buildConversationTree(messages)!, new Map(messages.map(m => [m.id, m])))

describe('Heimdall intermediate agent text', () => {
  it('hides long commentary among steps, but never the latest text before more reasoning/tools', () => {
    const messages = [row('user', null, 'Fix it', { role: 'user', meta: null }),
      row('reasoning', 'user', '', { content_blocks: thinking }),
      row('comment', 'reasoning', 'A long progress update. '.repeat(30)),
      row('tool', 'comment', '', { content_blocks: tools }),
      row('latest', 'tool', 'Done'), row('pending', 'latest', '', { content_blocks: tools })]
    expect([...classify(messages)]).toEqual(['comment'])
    messages.push(row('final', 'pending', 'Final answer'))
    expect(classify(messages)).toEqual(new Set(['comment', 'latest']))
  })

  it('handles commentary and process blocks on the same row and preserves a short final answer', () => {
    expect(classify([row('a', null, 'Working', { content_blocks: tools }), row('b', 'a', 'OK')]))
      .toEqual(new Set(['a']))
  })

  it('keeps ordinary prose-only responses', () => {
    expect(classify([row('a', null, 'First answer'), row('b', 'a', 'Second answer')])).toEqual(new Set())
  })

  it('never crosses run, conversation, user, unknown-record or malformed-metadata boundaries', () => {
    for (const boundary of [
      { meta: { runStatistics: { version: 1, streamId: 'next-run', kind: 'model_response' } } },
      { conversation_id: 'other' }, { role: 'user' as const }, { meta: null }, { meta: '{broken' },
      { meta: { runStatistics: { version: 9, streamId: 'run', kind: 'model_response' } } },
    ]) {
      expect(classify([row('a', null, 'Old answer', { content_blocks: tools }), row('b', 'a', 'New answer', boundary)]))
        .toEqual(new Set())
    }
    const root = buildConversationTree([row('a', null, 'Keep', { content_blocks: tools }), row('missing', 'a'), row('b', 'missing', 'Final')])!
    expect(getIntermediateAgentTextIds(root, new Map([['a', row('a', null, 'Keep', { content_blocks: tools })], ['b', row('b', 'missing', 'Final')]])))
      .toEqual(new Set())
  })

  it('does not infer ownership from a shared Claude session on legacy rows', () => {
    const meta = { claude: { sessionId: 'same-session' } }
    expect(classify([row('a', null, 'Keep', { meta, content_blocks: tools }), row('b', 'a', 'Final', { meta })])).toEqual(new Set())
  })

  it('parses SQLite JSON metadata and content blocks, including text-only blocks', () => {
    const messages = [row('a', null, '', { content_blocks: [{ type: 'text', content: 'Progress', index: 0 }, ...tools] }),
      row('b', 'a', '', { content_blocks: [{ type: 'text', content: 'Final', index: 0 }] })]
    for (const message of messages) {
      message.meta = JSON.stringify(message.meta)
      message.content_blocks = JSON.stringify(message.content_blocks) as unknown as ContentBlock[]
    }
    expect(classify(messages)).toEqual(new Set(['a']))
    messages[0].content_blocks = '{broken' as unknown as ContentBlock[]
    expect(classify(messages)).toEqual(new Set())
  })

  it('keeps a block-only final answer through the existing empty-message filter', () => {
    for (const blocks of [[{ type: 'text', content: 'Final', index: 0 }], [{ type: 'text', text: 'Final', index: 0 }]]) {
      for (const encoded of [blocks, JSON.stringify(blocks)]) {
        const messages = [row('a', null, 'Progress', { content_blocks: tools }),
          row('b', 'a', '', { content_blocks: encoded as unknown as ContentBlock[] })]
        const root = buildConversationTree(messages)!
        const byId = new Map(messages.map(message => [message.id, message]))
        const hidden = getIntermediateAgentTextIds(root, byId)
        const visible = filterChatTree(root, (node, hasSiblings) => ({
          promote: hidden.has(node.id) || shouldPromoteHeimdallNode({ isContextInjection: false,
            isOperationModeChange: false, isEmpty: !hasHeimdallTextContent(byId.get(node.id)!), hasSiblings, filterEmptyMessages: true }),
          message: node.message,
        }))
        expect(visible.map(node => node.id)).toEqual(['b'])
      }
    }
  })

  it('bridges generated context, mode and compaction rows without letting them replace final prose', () => {
    const messages = [row('a', null, 'Commentary', { content_blocks: tools }),
      row('context', 'a', 'Instructions', { role: 'user', meta: { kind: 'context_injection' } }),
      row('summary', 'context', 'Summary', { meta: { kind: 'compaction_summary', state: 'committed' } }),
      row('mode', 'summary', 'Mode', { role: 'user', meta: { kind: 'operation_mode_change' } }),
      row('final', 'mode', 'Answer')]
    expect(classify(messages)).toEqual(new Set(['a']))
    messages.pop()
    expect(classify(messages)).toEqual(new Set())
  })

  it('does not let Claude SDK placeholders displace the latest real text', () => {
    const meta = { runStatistics: { version: 1, streamId: 'run', kind: 'model_response' }, claude: { sessionId: 'session' } }
    const placeholder = row('placeholder', 'a', '', { meta, content_blocks: [
      { type: 'text', content: '[Claude redacted_thinking]', index: 0 }, ...tools,
    ] })
    expect(hasHeimdallTextContent(placeholder)).toBe(false)
    expect(classify([row('a', null, 'Real text', { meta, content_blocks: tools }), placeholder])).toEqual(new Set())
    // Real emitted text with identical spelling is still prose in row.content.
    expect(hasHeimdallTextContent({ ...placeholder, content: '[Claude redacted_thinking]' })).toBe(true)
    expect(hasHeimdallTextContent({ ...placeholder, meta: null })).toBe(true)
  })

  it('preserves errors, images and attachments even when later text exists', () => {
    for (const overrides of [
      { meta: { runStatistics: { version: 1, streamId: 'run', kind: 'terminal_error' } } },
      { content_blocks: [{ type: 'error', envelope: {}, index: 0 }] as unknown as ContentBlock[] },
      { content_blocks: [{ type: 'image', url: 'image', mimeType: 'image/png', index: 0 }] as ContentBlock[] },
      { has_attachments: true }, { attachments: [{ id: 'attachment' }] },
    ]) {
      expect(classify([row('a', null, 'Keep', { thinking_block: 'Thought', ...overrides }), row('b', 'a', 'Final')])).toEqual(new Set())
    }
  })

  it('keeps the last text independently on sibling branches', () => {
    const messages = [row('a', null, 'Shared commentary', { content_blocks: tools }),
      row('left', 'a', 'Left answer'), row('right', 'a', 'Right answer')]
    expect(classify(messages)).toEqual(new Set(['a']))
    // The shared message is still the last text on the right path.
    messages[2].content = ''
    messages[2].content_blocks = tools
    expect(classify(messages)).toEqual(new Set())
    // Work on another run must not hide this run's answer.
    messages[2] = row('right', 'a', 'Other run', { meta: { runStatistics: { version: 1, streamId: 'other', kind: 'model_response' } } })
    expect(classify(messages)).toEqual(new Set())
  })

  it('filters nodes using the existing traversal without changing canonical content or action paths', () => {
    const messages = [row('user', null, 'Fix it', { role: 'user', meta: null }),
      row('comment', 'user', 'Progress', { content_blocks: tools }), row('final', 'comment', 'Answer')]
    const root = buildConversationTree(messages)!
    const hidden = classify(messages)
    const visible = filterChatTree(root, node => ({ promote: hidden.has(node.id), message: node.message }))[0]
    expect(Array.from(walkChatTree(visible), node => node.id)).toEqual(['user', 'final'])
    expect(Array.from(walkChatTree(root), node => node.id)).toEqual(['user', 'comment', 'final'])
    expect(messages[1].content).toBe('Progress')
    expect(expandHeimdallSelectionToBranchMessages(messages, ['user', 'final'], new Set(['user', 'final'])))
      .toEqual(['user', 'comment', 'final'])
    // Turning the existing filter off renders the unfiltered graph again.
    expect(Array.from(walkChatTree(filterChatTree(root, node => ({ promote: false, message: node.message }))[0]), node => node.id))
      .toEqual(['user', 'comment', 'final'])
  })

  it('handles deep runs iteratively', () => {
    const messages = Array.from({ length: 20000 }, (_, i) => row(String(i), i ? String(i - 1) : null,
      i % 2 ? 'Text' : '', { content_blocks: i % 2 ? [] : tools }))
    const hidden = classify(messages)
    expect(hidden.size).toBe(9999)
    expect(hidden.has('19999')).toBe(false)
  })
})
