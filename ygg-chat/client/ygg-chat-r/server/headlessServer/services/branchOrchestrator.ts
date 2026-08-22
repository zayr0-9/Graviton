import type { HeadlessMessageRequest } from '../../../../../shared/headlessApi.js'

export interface ResolvedExecution {
  historyLeafId: string | null
  assistantParentId: string | null
  userContentForInference: string
  userMessage: any | null
}

interface BranchOrchestratorDeps {
  requireMessage: (messageId: string, conversationId: string) => any
  createUserMessage: (parentId: string | null, content: string) => any
  findNearestUserAncestor: (messageId: string, conversationId: string) => any | null
}

/**
 * Phase 2 continuation semantics resolver.
 *
 * Handles repeat/branch/edit-branch branching behavior so ChatOrchestrator can
 * stay focused on provider dispatch + persistence flow.
 */
export class BranchOrchestrator {
  resolve(request: HeadlessMessageRequest, deps: BranchOrchestratorDeps): ResolvedExecution {
    const operation = request.operation
    const trimmedContent = (request.content ?? '').trim()

    if (operation === 'send') {
      if (!trimmedContent) throw new Error('content is required')
      const userMessage = deps.createUserMessage(request.parentId ?? null, trimmedContent)
      return {
        historyLeafId: userMessage?.id ?? null,
        assistantParentId: userMessage?.id ?? null,
        userContentForInference: trimmedContent,
        userMessage,
      }
    }

    if (operation === 'branch') {
      const branchParentId = request.messageId ?? request.parentId ?? null
      if (!branchParentId) throw new Error('branch requires messageId or parentId')
      deps.requireMessage(branchParentId, request.conversationId)
      if (!trimmedContent) throw new Error('content is required')

      const userMessage = deps.createUserMessage(branchParentId, trimmedContent)
      return {
        historyLeafId: userMessage?.id ?? null,
        assistantParentId: userMessage?.id ?? null,
        userContentForInference: trimmedContent,
        userMessage,
      }
    }

    if (operation === 'edit-branch') {
      const originalMessageId = request.messageId ?? null
      if (!originalMessageId) throw new Error('edit-branch requires messageId')
      const originalMessage = deps.requireMessage(originalMessageId, request.conversationId)
      if (!trimmedContent) throw new Error('content is required')

      const siblingParentId = originalMessage.parent_id ?? null
      const userMessage = deps.createUserMessage(siblingParentId, trimmedContent)
      return {
        historyLeafId: userMessage?.id ?? null,
        assistantParentId: userMessage?.id ?? null,
        userContentForInference: trimmedContent,
        userMessage,
      }
    }

    // repeat
    let assistantParentId = request.parentId ?? null

    if (!assistantParentId) {
      const targetMessageId = request.messageId ?? null
      if (!targetMessageId) {
        throw new Error('repeat requires parentId or messageId')
      }

      const targetMessage = deps.requireMessage(targetMessageId, request.conversationId)
      assistantParentId = targetMessage.role === 'assistant' ? targetMessage.parent_id ?? null : targetMessage.id
    }

    if (!assistantParentId) {
      throw new Error('repeat could not resolve assistant parent message')
    }

    const userAnchor = deps.findNearestUserAncestor(assistantParentId, request.conversationId)
    if (!userAnchor) {
      throw new Error('repeat could not resolve user anchor message')
    }

    const userContentForInference =
      trimmedContent ||
      (typeof userAnchor.content === 'string' && userAnchor.content.trim() ? userAnchor.content.trim() : '')

    if (!userContentForInference) {
      throw new Error('repeat requires non-empty source user content')
    }

    return {
      historyLeafId: userAnchor.id,
      assistantParentId: userAnchor.id,
      userContentForInference,
      userMessage: null,
    }
  }
}
