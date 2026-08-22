import { describe, it, expect, vi } from 'vitest'
import type { HookRunRequest, HookRunResult } from '../../../hooks/hookTypes.js'
import {
  appendHookAdditionalContext,
  buildHookLineage,
  buildHookMetadata,
  buildSystemPromptWithHookContext,
  createChatHookSession,
  getAssistantMessageTextForHook,
  type ConversationRepoLike,
} from '../chatHookService.js'

// ── Pure builders ────────────────────────────────────────────────────────────

describe('buildHookLineage', () => {
  const chain = [
    { id: 'r', parent_id: null },
    { id: 'a', parent_id: 'r' },
    { id: 'b', parent_id: 'a' },
  ]

  it('persisted messageId: root -> depth len-1, isRoot when the chain is length 1', () => {
    const leaf = buildHookLineage({ messages: chain, messageId: 'b' })
    expect(leaf.ancestorIds).toEqual(['r', 'a', 'b'])
    expect(leaf.rootMessageId).toBe('r')
    expect(leaf.depth).toBe(2)
    expect(leaf.isRoot).toBe(false)

    const root = buildHookLineage({ messages: chain, messageId: 'r' })
    expect(root.ancestorIds).toEqual(['r'])
    expect(root.depth).toBe(0)
    expect(root.isRoot).toBe(true)
  })

  it('unpersisted messageId falls back to explicit parentId; isRoot when parentId is null', () => {
    const withParent = buildHookLineage({ messages: chain, messageId: 'new', parentId: 'b' })
    expect(withParent.ancestorIds).toEqual(['r', 'a', 'b'])
    expect(withParent.depth).toBe(3) // len (not len-1) for the unpersisted case
    expect(withParent.isRoot).toBe(false)

    const noParent = buildHookLineage({ messages: chain, messageId: 'new', parentId: null })
    expect(noParent.ancestorIds).toEqual([])
    expect(noParent.rootMessageId).toBeNull()
    expect(noParent.isRoot).toBe(true)
    expect(noParent.depth).toBe(0)
  })

  it('terminates on a parent_id cycle via the visited guard', () => {
    const cyclic = [
      { id: 'x', parent_id: 'y' },
      { id: 'y', parent_id: 'x' },
    ]
    const lineage = buildHookLineage({ messages: cyclic, messageId: 'x' })
    // walks x -> y then stops (x already visited); no infinite loop
    expect(lineage.ancestorIds).toEqual(['y', 'x'])
  })

  it('empty messages => empty root lineage', () => {
    expect(buildHookLineage({ messages: [], messageId: 'anything' })).toEqual({
      rootMessageId: null,
      ancestorIds: [],
      depth: 0,
      isRoot: true,
    })
  })
})

describe('buildSystemPromptWithHookContext', () => {
  it('places the base first and one [Hook context] block per entry, joined by blank lines', () => {
    const out = buildSystemPromptWithHookContext('BASE', ['first', 'second'])
    expect(out).toBe('BASE\n\n[Hook context]\nfirst\n\n[Hook context]\nsecond')
  })

  it('filters empty/whitespace entries and trims the base', () => {
    expect(buildSystemPromptWithHookContext('  BASE  ', ['', '  ', 'keep'])).toBe('BASE\n\n[Hook context]\nkeep')
  })

  it('null base with no context yields an empty string', () => {
    expect(buildSystemPromptWithHookContext(null, [])).toBe('')
  })
})

describe('appendHookAdditionalContext / getAssistantMessageTextForHook', () => {
  it('appends only non-empty trimmed strings', () => {
    const target: string[] = []
    appendHookAdditionalContext(target, '  hi  ')
    appendHookAdditionalContext(target, '')
    appendHookAdditionalContext(target, null)
    appendHookAdditionalContext(target, undefined)
    appendHookAdditionalContext(target, 42 as any)
    expect(target).toEqual(['hi'])
  })

  it('prefers content_plain_text, then content, else empty', () => {
    expect(getAssistantMessageTextForHook({ content_plain_text: ' plain ', content: 'raw' })).toBe(' plain ')
    expect(getAssistantMessageTextForHook({ content_plain_text: '  ', content: 'raw' })).toBe('raw')
    expect(getAssistantMessageTextForHook({ content: '' })).toBe('')
    expect(getAssistantMessageTextForHook(null)).toBe('')
  })
})

describe('buildHookMetadata', () => {
  const repo: ConversationRepoLike = {
    listMessages: () => [
      { id: 'u1', parent_id: null },
      { id: 'a1', parent_id: 'u1' },
    ],
    getMessageById: () => null,
  }

  it('back-fills parentId from the message row when messageId is set and parentId is null', () => {
    const meta = buildHookMetadata({ conversationRepo: repo, conversationId: 'c1', messageId: 'a1', localApiBase: 'http://x/api' })
    expect(meta.parentId).toBe('u1')
    expect(meta.lookup.localApiBase).toBe('http://x/api')
    expect(meta.lineage.ancestorIds).toEqual(['u1', 'a1'])
  })

  it('omits turn/project when absent; lookup.localApiBase defaults to null', () => {
    const meta = buildHookMetadata({ conversationRepo: repo, conversationId: 'c1' })
    expect(meta.turn).toBeUndefined()
    expect(meta.project).toBeUndefined()
    expect(meta.lookup.localApiBase).toBeNull()
  })

  it('null conversationId => no messages queried, empty lineage', () => {
    const listMessages = vi.fn(() => [])
    const meta = buildHookMetadata({ conversationRepo: { listMessages, getMessageById: () => null }, conversationId: null })
    expect(listMessages).not.toHaveBeenCalled()
    expect(meta.conversationId).toBeNull()
    expect(meta.lineage.ancestorIds).toEqual([])
  })
})

// ── Session ────────────────────────────────────────────────────────────────

const repo: ConversationRepoLike = {
  listMessages: () => [
    { id: 'u1', parent_id: null },
    { id: 'a1', parent_id: 'u1' },
  ],
  getMessageById: () => null,
}

function makeSession(runHook: (req: HookRunRequest) => Promise<HookRunResult>) {
  const calls: HookRunRequest[] = []
  const wrapped = async (req: HookRunRequest) => {
    calls.push(req)
    return runHook(req)
  }
  const session = createChatHookSession({
    conversationRepo: repo,
    runHook: wrapped,
    conversationId: 'c1',
    cwd: '/root',
    provider: 'lmstudio',
    model: 'qwen',
    operation: 'send',
    streamId: 's1',
    project: { projectId: 'p1', projectName: 'Proj' },
    localApiBase: 'http://x/api',
  })
  return { session, calls }
}

const noop: HookRunResult = { matched: false, hookCount: 0 }

describe('ChatHookSession dispatch + parity', () => {
  it('UserPromptSubmit: folds additionalContext, returns updatedPrompt, throws on blocked', async () => {
    const { session } = makeSession(async () => ({ matched: true, hookCount: 1, additionalContext: 'ctx', updatedPrompt: 'rewritten' }))
    const effective = await session.runUserPromptSubmit('original', null)
    expect(effective).toBe('rewritten')
    expect(session.hookContext).toEqual(['ctx'])

    const blocking = makeSession(async () => ({ matched: true, hookCount: 1, blocked: true, reason: 'nope' }))
    await expect(blocking.session.runUserPromptSubmit('x', null)).rejects.toThrow('nope')
  })

  it('UserPromptSubmit request carries project + no messageId (user not persisted yet)', async () => {
    const { session, calls } = makeSession(async () => noop)
    await session.runUserPromptSubmit('hi', 'u1')
    const req = calls[0]
    expect(req.event).toBe('UserPromptSubmit')
    expect(req.messageId).toBeNull()
    expect(req.prompt).toBe('hi')
    expect(req.project).toEqual({ projectId: 'p1', projectName: 'Proj' })
    expect(req.lookup?.localApiBase).toBe('http://x/api')
  })

  it('PreToolUse returns the raw result and does NOT carry project (renderer asymmetry)', async () => {
    const { session, calls } = makeSession(async () => ({ matched: true, hookCount: 1, updatedInput: { path: 'x' }, additionalContext: 'pre' }))
    const result = await session.runPreToolUse({ id: 't1', name: 'read_file', arguments: {} }, { conversationId: 'c1', messageId: 'a1', rootPath: '/tool-root' } as any)
    expect(result.updatedInput).toEqual({ path: 'x' })
    expect(session.hookContext).toEqual(['pre'])
    const req = calls[0]
    expect(req.event).toBe('PreToolUse')
    expect(req.messageId).toBe('a1')
    expect(req.cwd).toBe('/tool-root') // ctx.rootPath overrides session cwd
    expect(req.project).toBeUndefined()
    expect(req.toolCall).toMatchObject({ id: 't1', name: 'read_file' })
  })

  it('PostToolUse serializes the tool result to a string', async () => {
    const { session, calls } = makeSession(async () => noop)
    await session.runPostToolUse({ id: 't1', name: 'read_file' }, { persistedContent: { ok: true } }, { conversationId: 'c1', messageId: 'a1' } as any)
    expect(calls[0].event).toBe('PostToolUse')
    expect(calls[0].toolResult).toBe('{"ok":true}')
  })

  it('PostToolUseFailure stringifies the error', async () => {
    const { session, calls } = makeSession(async () => noop)
    await session.runPostToolUseFailure({ id: 't1', name: 'bash' }, new Error('boom'), { conversationId: 'c1', messageId: 'a1' } as any)
    expect(calls[0].event).toBe('PostToolUseFailure')
    expect(calls[0].error).toBe('boom')
  })

  it('Stop: returns true + appends reason on blocked, false otherwise; carries turn + project', async () => {
    const cont = makeSession(async () => ({ matched: true, hookCount: 1, blocked: true, reason: 'keep going', additionalContext: 'more' }))
    const should = await cont.session.toolLoopHooks().runStop({ assistantMessage: { id: 'a1', parent_id: 'u1' }, streamId: 's1' })
    expect(should).toBe(true)
    expect(cont.session.hookContext).toEqual(['more', 'keep going'])
    expect(cont.calls[0].event).toBe('Stop')
    expect(cont.calls[0].turn).toEqual({ lastUserMessageId: 'u1', lastAssistantMessageId: 'a1' })
    expect(cont.calls[0].project).toEqual({ projectId: 'p1', projectName: 'Proj' })

    const stop = makeSession(async () => noop)
    expect(await stop.session.toolLoopHooks().runStop({ assistantMessage: { id: 'a1', parent_id: 'u1' }, streamId: 's1' })).toBe(false)
  })

  it('swallows a runHook rejection (parity with the renderer chatHookClient swallow)', async () => {
    const { session } = makeSession(async () => {
      throw new Error('discovery failed')
    })
    // UserPromptSubmit must not abort the send on a hook-runner error (only on `blocked`)
    await expect(session.runUserPromptSubmit('keep', null)).resolves.toBe('keep')
    // Stop must not throw
    await expect(session.toolLoopHooks().runStop({ assistantMessage: { id: 'a1', parent_id: 'u1' }, streamId: 's1' })).resolves.toBe(false)
  })

  it('foldSystemPrompt leaves the base untouched when no context accumulated, folds when present', () => {
    const { session } = makeSession(async () => noop)
    const hooks = session.toolLoopHooks()
    expect(hooks.foldSystemPrompt('BASE')).toBe('BASE')
    expect(hooks.foldSystemPrompt(null)).toBeNull()
    hooks.hookContext.push('extra')
    expect(hooks.foldSystemPrompt('BASE')).toBe('BASE\n\n[Hook context]\nextra')
  })
})
