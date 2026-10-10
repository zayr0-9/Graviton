import { afterEach, describe, expect, it, vi } from 'vitest'
import { LmStudioProvider } from '../lmStudioProvider.js'
import { OpenRouterProvider } from '../openRouterProvider.js'
import { toHyperMessages } from '../hyperRouterAdapter.js'
import { toCodexMessages, toCodexRequestParts } from '../codex/codexRequestItems.js'

vi.mock('../../../auth/runtime.js', () => ({ getAuthManager: () => ({
  resolve: async () => ({ accessToken: 'test', sessionId: 'test', revision: 0 }),
}) }))
const url = 'data:image/png;base64,aW1hZ2U='
const input: any = { modelName: 'test', userContent: 'inspect', history: [
  { id: 'image-owner', role: 'user', content: 'inspect', artifacts: [url], attachments: [{ dataUrl: url }] },
  { id: 'mode', role: 'user', content: '<system-reminder>Agent mode</system-reminder>' },
  { role: 'assistant', content: 'tool completed' },
], railwayTurn: { conversationId: 'c1', attachmentsBase64: null } }
afterEach(() => vi.unstubAllGlobals())

describe('provider image history projection', () => {
  it('keeps exactly one Codex input_image on its owner on later turns', () => {
    const request = toCodexRequestParts(toCodexMessages(input), [])
    const owners = request.input.filter((item: any) => item.content?.some((part: any) => part.type === 'input_image'))
    expect(owners).toHaveLength(1)
    expect(owners[0].content).toContainEqual({ type: 'input_text', text: 'inspect' })
    expect(owners[0].content.filter((part: any) => part.type === 'input_image')).toEqual([{ type: 'input_image', image_url: url }])
  })

  it('sends LM Studio multipart user input including image-only history', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] })))
    vi.stubGlobal('fetch', fetch)
    await new LmStudioProvider().generate({ ...input, history: [{ ...input.history[0], content: '' }, input.history[1]] })
    const body = JSON.parse(fetch.mock.calls[0][1].body)
    expect(body.messages[0]).toEqual({ role: 'user', content: [{ type: 'image_url', image_url: { url } }] })
    expect(body.messages[1].content).toBe(input.history[1].content)
  })

  it('relays per-row artifacts to OpenRouter without a latest-user attachment side channel', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('data: [DONE]\n\n'))
    vi.stubGlobal('fetch', fetch)
    await new OpenRouterProvider().generate(input)
    const body = JSON.parse(fetch.mock.calls[0][1].body)
    expect(body.messages.find((row: any) => row.id === 'image-owner').artifacts).toEqual([url])
    expect(body.messages.find((row: any) => row.id === 'mode').artifacts).toEqual([])
    expect(body.attachmentsBase64).toBeUndefined()
  })

  it('rejects images explicitly in text-only adapters rather than pretending they were delivered', () => {
    expect(() => toHyperMessages(input)).toThrow('Image attachments are not supported')
  })
})
