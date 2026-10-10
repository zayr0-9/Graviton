import { describe, it, expect } from 'vitest'
import { buildServerLoopRequest } from './buildServerLoopRequest'

const base = {
  conversationId: 'conv-1',
  content: 'hello',
  provider: 'lmstudio',
  modelName: 'qwen',
  userId: 'user-1',
  operationMode: 'execute' as const,
  streamId: 'stream-1',
}

describe('buildServerLoopRequest', () => {
  it.each(['send', 'branch', 'edit'] as const)('never forwards direct MCP schemas for %s', op => {
    const { body } = buildServerLoopRequest(op, { ...base, messageId: 'm1', tools: [
      { name: 'mcp_manager' }, { name: 'mcp__server__echo' }, { name: 'legacy', isMcp: true },
    ] })
    expect((body.tools as any[]).map(tool => tool.name)).toEqual(['mcp_manager'])
  })
  it.each(['send', 'branch', 'edit'] as const)('forwards explicit full access for %s without changing other permissions', op => {
    const params = { ...base, messageId: 'm1', rootPath: '/workspace', toolAutoApprove: false, operationMode: 'plan' as const }
    expect(buildServerLoopRequest(op, params).body.fullAccess).toBe(false)
    expect(buildServerLoopRequest(op, { ...params, fullAccess: true }).body).toMatchObject({
      fullAccess: true, rootPath: '/workspace', cwd: '/workspace', toolAutoApprove: false, operationMode: 'plan',
    })
  })
  it.each(['send', 'branch', 'edit'] as const)('forwards Codex service tier for %s and omits it when off', op => {
    const params = { ...base, provider: 'openaichatgpt', modelName: 'gpt-6.1-sol', messageId: 'm1' }
    expect(buildServerLoopRequest(op, { ...params, serviceTier: 'priority' }).body.serviceTier).toBe('priority')
    expect(buildServerLoopRequest(op, params).body).not.toHaveProperty('serviceTier')
  })

  it('builds the send route + core body fields', () => {
    const { path, body } = buildServerLoopRequest('send', { ...base, parentId: 'p1' })
    expect(path).toBe('/conversations/conv-1/messages')
    expect(body).toMatchObject({
      content: 'hello',
      provider: 'lmstudio',
      modelName: 'qwen',
      userId: 'user-1',
      parentId: 'p1',
      operationMode: 'execute',
      includeOperationModePrompt: true,
      streamId: 'stream-1',
    })
  })

  it('forwards current lineage only when continuing and creates a fresh operation identity', () => {
    const first = buildServerLoopRequest('send', { ...base, currentLineageId: 'lineage-1' }).body
    const second = buildServerLoopRequest('send', { ...base, currentLineageId: null }).body

    expect(first.lineageId).toBe('lineage-1')
    expect(typeof first.operationId).toBe('string')
    expect(String(first.operationId).length).toBeGreaterThan(0)
    expect(second.operationId).not.toBe(first.operationId)
    expect('lineageId' in second).toBe(false)
  })

  it('preserves a caller-supplied operation identity across request construction', () => {
    const { body } = buildServerLoopRequest('branch', {
      ...base,
      messageId: 'm9',
      operationId: 'operation-fixed',
    })
    expect(body.operationId).toBe('operation-fixed')
  })

  it('forwards renderer-selected prompt baselines without sending a supplemental systemPrompt', () => {
    const { body } = buildServerLoopRequest('send', {
      ...base,
      operationModePrompt: 'Custom Agent baseline',
      agentModePrompt: 'Custom Agent baseline',
      subagentModePrompt: 'Custom Subagent baseline',
      planModeVerbosity: 'detailed',
    })

    expect(body).toMatchObject({
      operationModePrompt: 'Custom Agent baseline',
      agentModePrompt: 'Custom Agent baseline',
      subagentModePrompt: 'Custom Subagent baseline',
      planModeVerbosity: 'detailed',
    })
    expect('systemPrompt' in body).toBe(false)
  })

  it('branch/edit require messageId and build the right route', () => {
    expect(buildServerLoopRequest('branch', { ...base, messageId: 'm9' }).path).toBe('/conversations/conv-1/messages/m9/branch')
    expect(buildServerLoopRequest('edit', { ...base, messageId: 'm9' }).path).toBe('/conversations/conv-1/messages/m9/edit-branch')
    expect(() => buildServerLoopRequest('branch', { ...base })).toThrow(/branch requires messageId/)
    expect(() => buildServerLoopRequest('edit', { ...base })).toThrow(/edit requires messageId/)
  })

  it('sends only enabled tools, shaped to {name,description,inputSchema}', () => {
    const { body } = buildServerLoopRequest('send', {
      ...base,
      tools: [
        { name: 'read_file', description: 'r', enabled: true },
        { name: 'write_file', enabled: false },
        { name: 'bash' }, // enabled undefined => treated as enabled
      ],
    })
    expect(body.tools).toEqual([
      { name: 'read_file', description: 'r', inputSchema: { type: 'object', properties: {} } },
      { name: 'bash', description: undefined, inputSchema: { type: 'object', properties: {} } },
    ])
  })

  it('sends an explicit empty tools array when ALL tools are disabled (server must not substitute defaults)', () => {
    const { body } = buildServerLoopRequest('send', {
      ...base,
      tools: [{ name: 'read_file', enabled: false }],
    })
    expect(body.tools).toEqual([])
    expect('tools' in body).toBe(true)
  })

  it('omits the tools field entirely only when tools are not provided', () => {
    const { body } = buildServerLoopRequest('send', { ...base })
    expect('tools' in body).toBe(false)
  })

  it('forwards toolAutoApprove verbatim (true / false / undefined) with no coercion', () => {
    expect(buildServerLoopRequest('send', { ...base, toolAutoApprove: true }).body.toolAutoApprove).toBe(true)
    expect(buildServerLoopRequest('send', { ...base, toolAutoApprove: false }).body.toolAutoApprove).toBe(false)
    expect(buildServerLoopRequest('send', { ...base }).body.toolAutoApprove).toBeUndefined()
  })

  it('forwards hooksEnabled verbatim and localApiBase (defaulting null)', () => {
    const on = buildServerLoopRequest('send', { ...base, hooksEnabled: true, localApiBase: 'http://x/api' }).body
    expect(on.hooksEnabled).toBe(true)
    expect(on.localApiBase).toBe('http://x/api')

    const off = buildServerLoopRequest('send', { ...base }).body
    expect(off.hooksEnabled).toBeUndefined() // server gates on === true, so undefined == off
    expect(off.localApiBase).toBeNull()
  })

  it('forwards openrouter temperature + serviceTier only when set (no undefined keys)', () => {
    const on = buildServerLoopRequest('send', {
      ...base,
      provider: 'openrouter',
      temperature: 0.7,
      serviceTier: 'priority',
    }).body
    expect(on.provider).toBe('openrouter')
    expect(on.temperature).toBe(0.7)
    expect(on.serviceTier).toBe('priority')

    // Omitted for the local-provider path (undefined temperature / serviceTier) so the
    // lmstudio/zai body is byte-for-byte unchanged.
    const off = buildServerLoopRequest('send', { ...base }).body
    expect('temperature' in off).toBe(false)
    expect('serviceTier' in off).toBe(false)
  })

  it('never forwards legacy OAuth credentials', () => {
    const on = buildServerLoopRequest('send', {
      ...base,
      provider: 'openaichatgpt',
      accessToken: 'tok-abc',
      accountId: 'acct-1',
    }).body
    expect(on.accessToken).toBeUndefined()
    expect(on.accountId).toBeUndefined()

    // Omitted (no undefined/null keys) when the caller has no ChatGPT tokens.
    const off = buildServerLoopRequest('send', { ...base }).body
    expect('accessToken' in off).toBe(false)
    expect('accountId' in off).toBe(false)

    // null (getValidTokens miss) is treated as "not set" — omitted, not sent as null.
    const nulled = buildServerLoopRequest('send', { ...base, accessToken: null, accountId: null }).body
    expect('accessToken' in nulled).toBe(false)
    expect('accountId' in nulled).toBe(false)
  })

  it('resolves edit/branch routes and still requires messageId', () => {
    expect(buildServerLoopRequest('edit', { ...base, messageId: 'm9' }).path).toBe(
      '/conversations/conv-1/messages/m9/edit-branch'
    )
    expect(buildServerLoopRequest('branch', { ...base, messageId: 'm9' }).path).toBe(
      '/conversations/conv-1/messages/m9/branch'
    )
    expect(() => buildServerLoopRequest('edit', { ...base })).toThrow(/edit requires messageId/)
    expect(() => buildServerLoopRequest('branch', { ...base })).toThrow(/branch requires messageId/)
  })

  it('forwards the persisted subagent reasoning effort to the server loop', () => {
    const { body } = buildServerLoopRequest('send', { ...base, subagentReasoningEffort: 'xhigh' })
    expect(body.subagentReasoningEffort).toBe('xhigh')
  })
})
