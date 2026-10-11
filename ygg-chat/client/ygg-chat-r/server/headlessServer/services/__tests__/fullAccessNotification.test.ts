import { describe, expect, it, vi } from 'vitest'
import { ChatOrchestrator } from '../chatOrchestrator.js'
import { BranchOrchestrator } from '../branchOrchestrator.js'
import type { HeadlessMessageRequest } from '../../../../../../shared/headlessApi.js'

// Exercise the real placement path even when the native SQLite binding is unavailable.
function fixture() {
  const rows: any[] = []
  const orchestrator = Object.create(ChatOrchestrator.prototype) as any
  orchestrator.branchOrchestrator = new BranchOrchestrator()
  orchestrator.messageRepo = { findFullAccessNotification: vi.fn(() => null), createMessage: vi.fn((input: any) => {
    const row = { ...input, id: `row-${rows.length}`, parent_id: input.parentId }
    rows.push(row)
    return row
  }) }
  orchestrator.requireMessage = vi.fn(() => ({ id: 'original', parent_id: 'ancestor' }))
  orchestrator.persistContextInjectionMessage = vi.fn((_request, parentId) => ({ id: 'context', parent_id: parentId }))
  orchestrator.createUserMessage = vi.fn((_request, parentId, content) => ({ id: 'input', parent_id: parentId, content }))
  orchestrator.conversationRepo = { findNearestUserAncestor: vi.fn(() => ({ id: 'original', content: 'original input' })) }
  const request: HeadlessMessageRequest = { operation: 'send', conversationId: 'c1', parentId: 'ancestor',
    messageId: 'original', content: 'new input', provider: 'lmstudio', modelName: 'test',
    fullAccess: true, fullAccessNotificationId: 'toggle-1' }
  return { orchestrator, rows, request }
}

describe('deferred Full access insertion', () => {
  it.each(['send', 'branch', 'edit-branch'] as const)('orders context, access notice, and real input for %s', operation => {
    const { orchestrator, rows, request } = fixture()
    const onAccessMessage = vi.fn()
    const resolved = orchestrator.resolveExecution({ ...request, operation }, {
      launchInjection: { text: 'instructions', files: [], reason: 'session_start' }, onAccessMessage,
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ conversationId: 'c1', parentId: 'context', role: 'user',
      meta: { kind: 'full_access_change', requestId: 'toggle-1' } })
    expect(rows[0].content).toContain('<system-reminder>')
    expect(rows[0].content).toContain('Operation mode, tool approvals, and OS permissions still apply')
    expect(onAccessMessage).toHaveBeenCalledWith(rows[0], true)
    expect(resolved.userMessage).toMatchObject({ id: 'input', content: 'new input', parent_id: rows[0].id })
    expect(resolved.historyLeafId).toBe('input')
    expect(resolved.assistantParentId).toBe('input')
  })

  it.each([
    { fullAccess: false }, { fullAccessNotificationId: undefined },
    { watcherCompletion: { handle: 'watch', originMessageId: 'origin' } },
    { operation: 'repeat' as const },
  ])('does not insert for restricted, unrequested, automated, or repeat input: %j', changes => {
    const { orchestrator, rows, request } = fixture()
    orchestrator.resolveExecution({ ...request, ...changes })
    expect(rows).toEqual([])
  })

  it('acknowledges an already persisted toggle without inserting or reparenting another notice', () => {
    const { orchestrator, request, rows } = fixture()
    const existing = { id: 'prior-notice', meta: { kind: 'full_access_change', requestId: 'toggle-1' } }
    orchestrator.messageRepo.findFullAccessNotification.mockReturnValue(existing)
    const onAccessMessage = vi.fn()
    const resolved = orchestrator.resolveExecution(request, { onAccessMessage })
    expect(rows).toEqual([])
    expect(onAccessMessage).toHaveBeenCalledWith(existing, false)
    expect(resolved.userMessage.parent_id).toBe('ancestor')
  })

  it('does not mutate the captured run permission or operation mode', () => {
    const { orchestrator, request } = fixture()
    const before = { ...request, operationMode: 'plan' as const, toolAutoApprove: false }
    orchestrator.resolveExecution(before)
    expect(before).toEqual({ ...request, operationMode: 'plan', toolAutoApprove: false })
  })
})
