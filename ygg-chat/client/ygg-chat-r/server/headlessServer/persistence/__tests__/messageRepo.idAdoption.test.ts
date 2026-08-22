import { describe, expect, it, vi } from 'vitest'
import { MessageRepo } from '../messageRepo.js'

/**
 * Phase 4 — MessageRepo id adoption. DB-free: fake `statements`/`db` so we can assert
 * the id passed to upsertMessage without native better-sqlite3. Covers the cloud path
 * (adopt Railway's id) and the mint parity (no id => a fresh uuid).
 */
function makeRepo() {
  const runSpy = vi.fn()
  const statements = {
    upsertMessage: { run: runSpy },
    getMessageById: { get: vi.fn(() => ({ id: 'row', children_ids: '[]' })) },
    getConversationById: { get: vi.fn(() => ({})) },
  }
  const db = { prepare: vi.fn(() => ({ run: vi.fn() })) }
  return { repo: new MessageRepo({ db, statements }), runSpy }
}

const draft = {
  conversationId: 'c1',
  parentId: null,
  role: 'assistant' as const,
  content: 'hi',
}

describe('MessageRepo id adoption', () => {
  it('adopts a caller-supplied id as the message id (Railway authority on the cloud path)', () => {
    const { repo, runSpy } = makeRepo()
    repo.createMessage({ id: 'railway-1', ...draft })
    // upsertMessage.run receives the message id as its FIRST positional argument.
    expect(runSpy.mock.calls[0][0]).toBe('railway-1')
  })

  it('mints a fresh uuid when no id is supplied (default / native-provider parity)', () => {
    const { repo, runSpy } = makeRepo()
    repo.createMessage({ ...draft })
    const minted = runSpy.mock.calls[0][0]
    expect(minted).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
})
