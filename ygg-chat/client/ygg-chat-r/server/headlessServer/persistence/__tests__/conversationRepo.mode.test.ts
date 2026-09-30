import { describe, expect, it } from 'vitest'
import { ConversationRepo } from '../conversationRepo.js'

describe('repeat user anchor with mode notifications', () => {
  it.each([false, true])('skips a mode notification (JSON metadata: %s)', json => {
    const meta = { kind: 'operation_mode_change', mode: 'plan' }
    const messages: Record<string, any> = {
      u: { id: 'u', conversation_id: 'c', role: 'user', parent_id: null },
      n: { id: 'n', conversation_id: 'c', role: 'user', parent_id: 'u', meta: json ? JSON.stringify(meta) : meta },
      a: { id: 'a', conversation_id: 'c', role: 'assistant', parent_id: 'n' },
    }
    const repo = new ConversationRepo({ db: {}, statements: { getMessageById: { get: (id: string) => messages[id] } } })
    expect(repo.findNearestUserAncestor('c', 'a')?.id).toBe('u')
    expect(repo.findNearestUserAncestor('other', 'a')).toBeNull()
  })
})
