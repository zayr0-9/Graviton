import { beforeEach, describe, expect, it } from 'vitest'
import { clearSentMessageHistoryForTests, getSentMessageHistory, recordSentMessage } from './sentMessageHistory'

describe('sentMessageHistory', () => {
  beforeEach(() => clearSentMessageHistoryForTests())

  it('keeps sent messages in insertion order', () => {
    recordSentMessage('first')
    recordSentMessage('second')

    expect(getSentMessageHistory()).toEqual(['first', 'second'])
  })

  it('ignores empty input and returns a readonly snapshot', () => {
    recordSentMessage('   ')
    recordSentMessage('message')

    const history = getSentMessageHistory()
    expect(history).toEqual(['message'])
    expect(Object.isFrozen(history)).toBe(true)
  })
})
