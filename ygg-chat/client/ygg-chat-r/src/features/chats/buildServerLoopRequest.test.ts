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
})
