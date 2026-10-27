import { afterEach, describe, expect, it, vi } from 'vitest'
import { HookGenerationService } from '../hookGenerationService.js'
import { DEFAULT_HOST_HOOK_GENERATION } from '../../../../../../shared/hostHookGeneration.js'

const body = { content: 'private user turn', systemPrompt: 'Return JSON' }
const make = (provider = 'auto', status = 'ready') => {
  const openAi = vi.fn(async () => ({ text: '{}', modelName: 'gpt-6-luna' }))
  const claude = vi.fn(async () => ({ text: '{}', modelName: 'native-model' }))
  const preferences = { ...DEFAULT_HOST_HOOK_GENERATION, provider } as any
  const service = new HookGenerationService({ preferences: () => preferences, openAiStatus: () => status, openAi, claude })
  return { service, openAi, claude, preferences }
}
afterEach(() => vi.useRealTimers())
describe('hook provider resolution', () => {
  it.each(['ready', 'refreshing', 'temporary_unavailable', 'configuration_error'])('Auto retains OpenAI for %s without speculative fallback', async status => {
    const { service, openAi, claude } = make('auto', status)
    expect(await service.generate(body)).toMatchObject({ provider: 'openaichatgpt', text: '{}' })
    expect(openAi).toHaveBeenCalledOnce(); expect(claude).not.toHaveBeenCalled()
  })
  it.each(['signed_out', 'reauth_required'])('Auto chooses Claude before dispatch for %s', async status => {
    const { service, openAi, claude } = make('auto', status)
    expect(await service.generate({ ...body, provider: 'openai', modelName: 'obsolete-legacy-model' })).toMatchObject({ provider: 'claudecode', modelName: 'native-model' })
    expect(openAi).not.toHaveBeenCalled(); expect(claude).toHaveBeenCalledOnce()
  })
  it.each(['openaichatgpt', 'claudecode'])('honors explicit %s independently of login and legacy hints', async provider => {
    const { service, openAi, claude } = make(provider, 'signed_out')
    expect((await service.generate({ ...body, provider: 'other' })).provider).toBe(provider)
    expect(openAi).toHaveBeenCalledTimes(provider === 'openaichatgpt' ? 1 : 0)
    expect(claude).toHaveBeenCalledTimes(provider === 'claudecode' ? 1 : 0)
  })
  it.each(['429 rate limit', '401 auth failed', 'network timeout', 'invalid model'])('never retries %s on another provider or exposes raw error', async message => {
    const { service, openAi, claude } = make()
    openAi.mockRejectedValueOnce(new Error(`${message}: private prompt`))
    await expect(service.generate(body)).rejects.toThrow('no other provider was tried')
    expect(claude).not.toHaveBeenCalled()
  })
  it('explicit Claude is independent of a corrupt/unavailable OpenAI auth store', async () => {
    const claude = vi.fn(async () => ({ text: '{}', modelName: 'native' }))
    const service = new HookGenerationService({ preferences: () => ({ ...DEFAULT_HOST_HOOK_GENERATION, provider: 'claudecode' }),
      openAiStatus: () => { throw new Error('broken OpenAI state') }, openAi: vi.fn(), claude })
    expect((await service.generate(body)).provider).toBe('claudecode')
  })
  it.each(['', 'x'.repeat(128001)])('rejects invalid text without retry', async text => {
    const { service, openAi, claude } = make()
    openAi.mockResolvedValueOnce({ text, modelName: 'test' })
    await expect(service.generate(body)).rejects.toThrow('empty or oversized')
    expect(claude).not.toHaveBeenCalled()
  })
  it('snapshots the saved model and enforces cancellation/concurrency until adapters settle', async () => {
    vi.useFakeTimers()
    const { service, openAi, claude, preferences } = make()
    let finish!: (result: any) => void
    openAi.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const controller = new AbortController()
    const first = service.generate(body, controller.signal)
    const rejection = expect(first).rejects.toMatchObject({ status: 504 })
    preferences.openAiModel = 'new-model'
    preferences.provider = 'claudecode'
    const second = service.generate(body)
    await expect(second).resolves.toMatchObject({ provider: 'claudecode' })
    controller.abort(); await rejection
    expect(openAi.mock.calls[0][0].modelName).toBe('gpt-6-luna')
    expect(openAi.mock.calls[0][0].signal.aborted).toBe(true)
    finish({ text: '{}', modelName: 'gpt-6-luna' })
    await Promise.resolve()
    expect(claude).toHaveBeenCalledOnce()
  })
  it('bounds hung adapters, retains slots and does not fallback', async () => {
    vi.useFakeTimers()
    const { service, openAi, claude } = make()
    const releases: Array<(value: any) => void> = []
    openAi.mockImplementation(() => new Promise(resolve => releases.push(resolve)))
    const first = expect(service.generate(body)).rejects.toMatchObject({ status: 504 })
    const second = expect(service.generate(body)).rejects.toMatchObject({ status: 504 })
    await expect(service.generate(body)).rejects.toMatchObject({ status: 429 })
    await vi.advanceTimersByTimeAsync(40000)
    await first; await second
    await expect(service.generate(body)).rejects.toMatchObject({ status: 429 })
    releases.forEach(release => release({ text: '{}', modelName: 'test' }))
    await Promise.resolve()
    expect(claude).not.toHaveBeenCalled()
  })
  it.each([{ content: '' }, { content: 'a'.repeat(128001) }, { content: 'ok', history: [{}] }, { content: 'ok', systemPrompt: 5 }])('rejects malformed or oversized generation input', async input => {
    const { service, openAi, claude } = make()
    await expect(service.generate(input)).rejects.toMatchObject({ status: 400 })
    expect(openAi).not.toHaveBeenCalled(); expect(claude).not.toHaveBeenCalled()
  })
})
