import '../features/chats/__testSupport__/localStorageShim'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import chatReducer, { chatSliceActions } from '../features/chats/chatSlice'

const source = readFileSync(new URL('./Chat.tsx', import.meta.url), 'utf8')

// Exercise the actual container callback without mounting its route, transports and transcript.
function composer(initialDraft: string) {
  let state = chatReducer(undefined, { type: 'init' })
  state = chatReducer(state, chatSliceActions.inputChanged({ content: initialDraft }))
  let localValue = initialDraft
  const clear = vi.fn(() => { localValue = '' })
  const dispatch = (action: ReturnType<typeof chatSliceActions.inputChanged>) => {
    state = chatReducer(state, action)
  }
  const body = source.match(/const clearLocalInput = useCallback\(\(\) => \{([\s\S]*?)\n  \}, \[[^\]]*\]\)/)?.[1]
  if (!body) throw new Error('Missing clearLocalInput callback')
  const clearLocalInput = new Function('inputControllerRef', 'dispatch', 'chatSliceActions', body)
  return {
    clear: () => clearLocalInput({ current: { clear } }, dispatch, chatSliceActions),
    state: () => state,
    value: () => localValue,
    dispatch,
  }
}

describe('primary composer submission', () => {
  it.each(['', 'previously blurred draft'])('clears local and Redux text with saved draft %j', draft => {
    const input = composer(draft)
    input.clear()
    expect(input.value()).toBe('')
    expect(input.state().composition.input.content).toBe('')
    expect(input.state().composition.validationError).toBeNull()
  })

  it('does not invalidate attachment preparation when clearing submitted text', () => {
    const input = composer('message with an image')
    const before = input.state().composition
    input.clear()
    const after = input.state().composition
    expect(after.imageDrafts).toBe(before.imageDrafts)
    expect(after.imageDraftTarget).toBe(before.imageDraftTarget)
    expect(after.imagePreparationGeneration).toBe(before.imagePreparationGeneration)
  })

  it('does not publish processed send content back into the composer draft', () => {
    const sendBody = source.slice(source.indexOf('const sendWithParent ='), source.indexOf('// Context checks and compaction belong'))
    expect(sendBody).toContain('const inputToSend = { content: contentToSend }')
    expect(sendBody).toContain('clearLocalInput()')
    expect(sendBody).not.toContain('chatSliceActions.inputChanged')
  })
})
