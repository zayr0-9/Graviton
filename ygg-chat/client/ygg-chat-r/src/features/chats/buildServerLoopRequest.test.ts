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

  it('never sends a systemPrompt (server assembles it; avoid double-prompt)', () => {
    const { body } = buildServerLoopRequest('send', { ...base })
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

  it('forwards ChatGPT accessToken + accountId only when set', () => {
    const on = buildServerLoopRequest('send', {
      ...base,
      provider: 'openaichatgpt',
      accessToken: 'tok-abc',
      accountId: 'acct-1',
    }).body
    expect(on.accessToken).toBe('tok-abc')
    expect(on.accountId).toBe('acct-1')

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
})
