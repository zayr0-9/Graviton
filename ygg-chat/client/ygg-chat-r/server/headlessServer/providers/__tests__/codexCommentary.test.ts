import { describe, expect, it } from 'vitest'
import { parseCodexSseText } from '../codex/codexSse.js'

const message = (id: string, phase: string | undefined, text: string) => ({
  id, type: 'message', role: 'assistant', ...(phase ? { phase } : {}), content: [{ type: 'output_text', text }],
})
const frames = (events: any[]) => events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')
const streamMessage = (item: ReturnType<typeof message>) => [
  { type: 'response.output_item.added', item: { ...item, content: [] } },
  { type: 'response.output_text.delta', item_id: item.id, delta: item.content[0].text },
  { type: 'response.output_text.done', item_id: item.id, text: item.content[0].text },
  { type: 'response.output_item.done', item },
]

describe('Codex commentary display', () => {
  it('preserves multipart text and deduplicates multipart reasoning', () => {
    const result = parseCodexSseText(frames([
      { type: 'response.output_item.added', item: { id: 'p', type: 'message', phase: 'commentary' } },
      { type: 'response.output_text.delta', item_id: 'p', content_index: 0, delta: 'First. ' },
      { type: 'response.output_text.done', item_id: 'p', content_index: 0, text: 'First. ' },
      { type: 'response.output_text.delta', item_id: 'p', content_index: 1, delta: 'Second.' },
      { type: 'response.output_text.done', item_id: 'p', content_index: 1, text: 'Second.' },
      { type: 'response.reasoning_summary_text.delta', item_id: 'r', summary_index: 0, delta: 'One' },
      { type: 'response.reasoning_summary_text.delta', item_id: 'r', summary_index: 1, delta: 'Two' },
      { type: 'response.output_item.done', item: { id: 'r', type: 'reasoning', summary: [{ text: 'One' }, { text: 'Two' }] } },
    ]))
    expect(result.contentBlocks.map(block => block.content)).toEqual(['First. Second.', 'One\n\nTwo'])
    expect(result.content).toBe('')
  })

  it('reserves item order when tool arguments or message text arrive after later items', () => {
    const commentary = message('progress', 'commentary', 'Reading now.')
    const call = { id: 'fc', call_id: 'call', type: 'function_call', name: 'read_file', arguments: '{}' }
    const answer = message('answer', 'final_answer', 'Answer')
    const result = parseCodexSseText(frames([
      { type: 'response.output_item.added', item: { ...commentary, content: [] } },
      { type: 'response.output_item.added', item: { ...call, arguments: '' } },
      ...streamMessage(answer),
      { type: 'response.output_item.done', item: commentary },
      { type: 'response.output_item.done', item: call },
      { type: 'response.completed', response: { output: [commentary, call, answer] } },
    ]))
    expect(result.contentBlocks.map(block => block.type)).toEqual(['text', 'tool_use', 'text'])
    expect(result.contentBlocks[0].content).toBe('Reading now.')
  })

  it('streams and persists commentary in order without changing the selected answer or replay phases', () => {
    const commentary = message('progress', 'commentary', 'I will inspect the code.')
    const answer = message('answer', 'final_answer', 'Found the cause.')
    const reasoning = { id: 'reason', type: 'reasoning', summary: [{ type: 'summary_text', text: 'Inspecting' }] }
    const call = { id: 'call', call_id: 'call', type: 'function_call', name: 'read_file', arguments: '{"path":"README.md"}' }
    const emitted: any[] = []
    const result = parseCodexSseText(frames([
      ...streamMessage(commentary),
      { type: 'response.reasoning_summary_text.delta', item_id: 'reason', delta: 'Inspecting' },
      { type: 'response.output_item.done', item: reasoning },
      { type: 'response.output_item.done', item: call },
      ...streamMessage(answer),
      { type: 'response.completed', response: { output: [commentary, reasoning, call, answer] } },
    ]), { emit: event => emitted.push(event) })
    expect(result.content).toBe('Found the cause.')
    expect(result.contentBlocks.map(block => block.type)).toEqual(['text', 'thinking', 'tool_use', 'text'])
    expect(result.contentBlocks.map(block => block.index)).toEqual([0, 1, 2, 3])
    expect(result.contentBlocks.filter(block => block.type === 'text').map(block => block.content))
      .toEqual(['I will inspect the code.', 'Found the cause.'])
    expect(emitted.filter(event => event.part === 'text').map(event => event.delta))
      .toEqual(['I will inspect the code.', '\n\nFound the cause.'])
    expect(result.outputItems?.filter(item => item.type === 'message').map(item => item.phase)).toEqual(['commentary', 'final_answer'])
    expect(result.toolCalls).toHaveLength(1)
  })

  it('keeps commentary-only display separate from empty-answer recovery', () => {
    const item = message('progress', 'commentary', 'Still working.')
    const result = parseCodexSseText(frames([...streamMessage(item), { type: 'response.completed', response: { output: [item] } }]))
    expect(result.content).toBe('')
    expect(result.contentBlocks).toEqual([{ type: 'text', content: 'Still working.', index: 0 }])
    expect(parseCodexSseText(frames([{ type: 'response.completed', response: { output: [item] } }]), { allowCommentaryFallbackText: true }).content)
      .toBe('Still working.')
  })

  it('handles completed-only output without IDs and phase-unknown legacy answers', () => {
    const { id: _a, ...commentary } = message('a', 'commentary', 'Progress')
    const { id: _b, ...answer } = message('b', undefined, 'Answer')
    const result = parseCodexSseText(frames([{ type: 'response.completed', response: { output: [commentary, answer] } }]))
    expect(result.content).toBe('Answer')
    expect(result.contentBlocks.map(block => block.content)).toEqual(['Progress', 'Answer'])
  })

  it('emits a done-only suffix once and retains commentary on transport failure', () => {
    const item = message('progress', 'commentary', 'Checking files')
    const emitted: any[] = []
    let failure: any
    try {
      parseCodexSseText(frames([
        { type: 'response.output_item.added', item: { ...item, content: [] } },
        { type: 'response.output_text.delta', item_id: item.id, delta: 'Checking' },
        { type: 'response.output_text.done', item_id: item.id, text: 'Checking files' },
        { type: 'response.output_item.done', item },
        { type: 'response.failed', response: { error: { message: 'Disconnected' } } },
      ]), { emit: event => emitted.push(event) })
    } catch (error) { failure = error }
    expect(failure?.message).toContain('Disconnected')
    expect(failure.partialOutput.contentBlocks).toEqual([{ type: 'text', content: 'Checking files', index: 0 }])
    expect(emitted.map(event => event.delta)).toEqual(['Checking', ' files'])
  })
})
