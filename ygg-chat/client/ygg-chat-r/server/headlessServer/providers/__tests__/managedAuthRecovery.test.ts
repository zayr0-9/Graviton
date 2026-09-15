import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthSessionManager, type Credential, type CredentialStore } from '../../../auth/authSessionManager.js'
import { OpenAiChatgptProvider } from '../openaiChatgptProvider.js'

function owner() {
  let value: Credential | null = null
  const store: CredentialStore = { read: () => value, isInitialized: () => true, write: (_slot, next) => { value = next } }
  const refresh = vi.fn(async (_slot, old: Credential) => ({ ...old, accessToken: 'renewed', expiresAt: Date.now() + 3600000 }))
  const auth = new AuthSessionManager(store, refresh)
  auth.replace('codex', { userId: 'acct', accessToken: 'original', refreshToken: 'refresh', expiresAt: Date.now() + 3600000 })
  return { auth, refresh }
}
const success = () => new Response('data: {"type":"response.completed","response":{"id":"r","output":[{"type":"message","role":"assistant","phase":"final_answer","content":[{"type":"output_text","text":"ok"}]}]}}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
afterEach(() => vi.unstubAllGlobals())
describe('Codex managed auth recovery', () => {
  it('refreshes a rejected revision and rebuilds authorization once', async () => {
    const { auth, refresh } = owner()
    const fetch = vi.fn().mockResolvedValueOnce(new Response('{}', { status: 401 })).mockResolvedValueOnce(success())
    vi.stubGlobal('fetch', fetch)
    await new OpenAiChatgptProvider({ auth }).generate({ modelName: 'gpt-5.4-mini', history: [], userContent: 'hi', systemPrompt: '' })
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(new Headers(fetch.mock.calls[0][1].headers).get('authorization')).toBe('Bearer original')
    expect(new Headers(fetch.mock.calls[1][1].headers).get('authorization')).toBe('Bearer renewed')
  })
  it('ends with reconnect state after a second rejection', async () => {
    const { auth, refresh } = owner()
    const fetch = vi.fn(async () => new Response('{}', { status: 401 }))
    vi.stubGlobal('fetch', fetch)
    await expect(new OpenAiChatgptProvider({ auth }).generate({ modelName: 'gpt-5.4-mini', history: [], userContent: 'hi', systemPrompt: '' })).rejects.toMatchObject({ category: 'reauth_required', slot: 'codex' })
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(auth.snapshot('codex').status).toBe('reauth_required')
  })
})
