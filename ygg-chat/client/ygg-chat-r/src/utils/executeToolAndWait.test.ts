import { afterEach, describe, expect, it, vi } from 'vitest'

const post = vi.hoisted(() => vi.fn())
vi.mock('./api', () => ({ localApi: { post }, environment: 'electron' }))

import { executeToolAndWait } from './executeToolAndWait'
import { createMessageHandler } from './iframeBridge'

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('executeToolAndWait', () => {
  it.each([{ action: 'list' }, { action: 'read', name: 'saved-theme' }])('routes theme requests through jobs: %j', async args => {
    const result = { success: true, themes: [], theme: { name: 'saved-theme' } }
    post.mockResolvedValue({ success: true, job: { id: 'job-1' }, result })
    expect(await executeToolAndWait({ toolName: 'theme_manager', args })).toEqual({ result })
    expect(post).toHaveBeenCalledWith('/jobs/execute-and-wait', { toolName: 'theme_manager', args })
  })

  it('preserves tool-level failures from completed jobs', async () => {
    const result = { success: false, error: 'Theme not found' }
    post.mockResolvedValue({ success: true, result })
    expect(await executeToolAndWait({ toolName: 'theme_manager', args: {} })).toEqual({ result })
  })

  it('surfaces job failures instead of dropping the error envelope', async () => {
    post.mockResolvedValue({ success: false, error: 'Unknown tool' })
    await expect(executeToolAndWait({ toolName: 'missing', args: {} })).rejects.toThrow('Unknown tool')
  })

  it('propagates transport errors without retrying the tool', async () => {
    post.mockRejectedValue(new Error('Connection closed'))
    await expect(executeToolAndWait({ toolName: 'bash', args: {} })).rejects.toThrow('Connection closed')
    expect(post).toHaveBeenCalledOnce()
  })
})

function bridge() {
  vi.stubGlobal('window', {})
  const contentWindow = { postMessage: vi.fn() }
  const iframe = { contentWindow } as unknown as HTMLIFrameElement
  const handler = createMessageHandler(
    { getIframe: () => iframe, getUserId: () => null },
    { targets: new Set(), pendingEvents: new Map(), awaitingResponse: 0 },
    vi.fn()
  )
  const run = (options: object, source: unknown = contentWindow) => handler({
    source, data: { type: 'EXECUTE_TOOL', requestId: 'request-1', options },
  } as MessageEvent)
  return { run, contentWindow }
}

describe('iframe EXECUTE_TOOL migration', () => {
  it('maps the public tool field to toolName and returns only the tool payload', async () => {
    const { run, contentWindow } = bridge()
    post.mockResolvedValue({ success: true, job: { id: 'job-1' }, result: { success: true, stdout: 'ok' } })
    await run({ tool: 'bash', args: { command: 'echo ok' } })
    expect(post).toHaveBeenCalledWith('/jobs/execute-and-wait', { toolName: 'bash', args: { command: 'echo ok' } })
    expect(contentWindow.postMessage).toHaveBeenCalledWith({
      type: 'EXECUTE_TOOL_RESPONSE', requestId: 'request-1', success: true, stdout: 'ok',
    }, '*')
  })

  it('returns job failures through the existing iframe error response', async () => {
    const { run, contentWindow } = bridge()
    post.mockResolvedValue({ success: false, error: 'Unknown tool' })
    await run({ tool: 'missing' })
    expect(contentWindow.postMessage).toHaveBeenCalledWith({
      type: 'EXECUTE_TOOL_RESPONSE', requestId: 'request-1', success: false, error: 'Error: Unknown tool',
    }, '*')
  })

  it('rejects missing names without submitting jobs', async () => {
    const { run, contentWindow } = bridge()
    await run({})
    expect(post).not.toHaveBeenCalled()
    expect(contentWindow.postMessage).toHaveBeenCalledWith({
      type: 'EXECUTE_TOOL_RESPONSE', requestId: 'request-1', success: false, error: 'Missing tool name',
    }, '*')
  })

  it('ignores messages from a different iframe', async () => {
    const { run, contentWindow } = bridge()
    await run({ tool: 'bash' }, {})
    expect(post).not.toHaveBeenCalled()
    expect(contentWindow.postMessage).not.toHaveBeenCalled()
  })
})
