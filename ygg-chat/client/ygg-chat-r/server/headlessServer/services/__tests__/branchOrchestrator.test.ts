import { describe, expect, it } from 'vitest'
import { BranchOrchestrator } from '../branchOrchestrator.js'

function createDeps(messages: Record<string, any>) {
  const created: any[] = []

  return {
    created,
    deps: {
      requireMessage: (messageId: string, conversationId: string) => {
        const msg = messages[messageId]
        if (!msg || msg.conversation_id !== conversationId) {
          throw new Error(`Message not found in conversation: ${messageId}`)
        }
        return msg
      },
      createUserMessage: (parentId: string | null, content: string) => {
        const createdMessage = {
          id: `u-${created.length + 1}`,
          conversation_id: 'c1',
          parent_id: parentId,
          role: 'user',
          content,
        }
        created.push(createdMessage)
        return createdMessage
      },
      findNearestUserAncestor: (messageId: string) => {
        let cursor: string | null = messageId
        while (cursor) {
          const msg = messages[cursor]
          if (!msg) return null
          if (msg.role === 'user') return msg
          cursor = msg.parent_id ?? null
        }
        return null
      },
    },
  }
}

describe('BranchOrchestrator', () => {
  const orchestrator = new BranchOrchestrator()

  it('resolves send', () => {
    const { deps } = createDeps({})

    const resolved = orchestrator.resolve(
      {
        operation: 'send',
        conversationId: 'c1',
        parentId: null,
        content: 'hello',
        provider: 'openaichatgpt',
        modelName: 'gpt-5.1-codex-mini',
      },
      deps as any
    )

    expect(resolved.userMessage?.content).toBe('hello')
    expect(resolved.assistantParentId).toBe(resolved.userMessage.id)
  })

  it('resolves repeat from assistant into user anchor', () => {
    const { deps } = createDeps({
      a1: { id: 'a1', conversation_id: 'c1', role: 'assistant', parent_id: 'u1', content: 'answer' },
      u1: { id: 'u1', conversation_id: 'c1', role: 'user', parent_id: null, content: 'question' },
    })

    const resolved = orchestrator.resolve(
      {
        operation: 'repeat',
        conversationId: 'c1',
        parentId: null,
        messageId: 'a1',
        content: '',
        provider: 'openaichatgpt',
        modelName: 'gpt-5.1-codex-mini',
      },
      deps as any
    )

    expect(resolved.userMessage).toBeNull()
    expect(resolved.assistantParentId).toBe('u1')
    expect(resolved.userContentForInference).toBe('question')
  })

  it('resolves branch and edit-branch parent semantics', () => {
    const { deps } = createDeps({
      u0: { id: 'u0', conversation_id: 'c1', role: 'user', parent_id: null, content: 'root' },
      u1: { id: 'u1', conversation_id: 'c1', role: 'user', parent_id: 'u0', content: 'old text' },
    })

    const branchResolved = orchestrator.resolve(
      {
        operation: 'branch',
        conversationId: 'c1',
        parentId: null,
        messageId: 'u0',
        content: 'branch prompt',
        provider: 'openaichatgpt',
        modelName: 'gpt-5.1-codex-mini',
      },
      deps as any
    )

    const editResolved = orchestrator.resolve(
      {
        operation: 'edit-branch',
        conversationId: 'c1',
        parentId: null,
        messageId: 'u1',
        content: 'edited prompt',
        provider: 'openaichatgpt',
        modelName: 'gpt-5.1-codex-mini',
      },
      deps as any
    )

    expect(branchResolved.userMessage.parent_id).toBe('u0')
    expect(editResolved.userMessage.parent_id).toBe('u0')
  })
})
