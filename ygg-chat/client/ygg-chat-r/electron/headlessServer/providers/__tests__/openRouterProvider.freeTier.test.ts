import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenRouterProvider, type ProviderGenerateInput } from '../openRouterProvider.js'
import type { HeadlessStreamEvent } from '../../contracts/headlessApi.js'

/**
 * Phase 4 — OpenRouterProvider free-tier relay. DB-free: stubs global.fetch so the
 * provider parses a fake Railway SSE stream / 403, and asserts the two new SSE events
 * are emitted ONLY when relayFreeTierEvents is set (drop parity otherwise).
 */

/** A fake streaming Response: yields all chunks on the first read, then done. */
function makeStreamResponse(chunks: string[]): any {
  let i = 0
  return {
    ok: true,
    status: 200,
    body: {
      getReader() {
        return {
          read: async () =>
            i < chunks.length
              ? { done: false, value: new TextEncoder().encode(chunks[i++]) }
              : { done: true, value: undefined },
          cancel: async () => {},
        }
      },
    },
    text: async () => chunks.join(''),
  }
}

/** A fake non-ok Response (403 has no readable body path in the provider). */
function makeErrorResponse(status: number, bodyText: string): any {
  return {
    ok: false,
    status,
    body: { getReader: () => ({ read: async () => ({ done: true }), cancel: async () => {} }) },
    text: async () => bodyText,
  }
}

function baseInput(relayFreeTierEvents: boolean | undefined): ProviderGenerateInput {
  return {
    modelName: 'test-model',
    systemPrompt: null,
    history: [],
    userContent: 'hi',
    accessToken: 'test-token', // satisfies resolveAuth without a token store / env
    railwayTurn: { conversationId: 'c1', relayFreeTierEvents },
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('OpenRouterProvider free-tier relay', () => {
  it('relays a free_generations_update frame as an SSE event when the flag is set', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        makeStreamResponse([`data: {"type":"free_generations_update","remaining":41}\n\n`, `data: [DONE]\n\n`])
      )
    )
    const events: HeadlessStreamEvent[] = []
    await new OpenRouterProvider().generate(baseInput(true), e => events.push(e))

    const freeTier = events.filter(e => e.type === 'free_generations_update')
    expect(freeTier).toHaveLength(1)
    expect(freeTier[0]).toEqual({ type: 'free_generations_update', remaining: 41, isFreeTier: true })
  })

  it('DROPS the free_generations_update frame when the flag is unset (parity with today)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        makeStreamResponse([`data: {"type":"free_generations_update","remaining":41}\n\n`, `data: [DONE]\n\n`])
      )
    )
    const events: HeadlessStreamEvent[] = []
    await new OpenRouterProvider().generate(baseInput(false), e => events.push(e))

    expect(events.filter(e => e.type === 'free_generations_update')).toHaveLength(0)
  })

  it('honors an explicit isFreeTier:false on the frame', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        makeStreamResponse([`data: {"type":"free_generations_update","remaining":0,"isFreeTier":false}\n\n`])
      )
    )
    const events: HeadlessStreamEvent[] = []
    await new OpenRouterProvider().generate(baseInput(true), e => events.push(e))

    expect(events.filter(e => e.type === 'free_generations_update')[0]).toEqual({
      type: 'free_generations_update',
      remaining: 0,
      isFreeTier: false,
    })
  })

  it('emits generation_limit_reached on a 403 when the flag is set, and still throws', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => makeErrorResponse(403, JSON.stringify({ error: 'generation_limit_reached', message: 'Upgrade' })))
    )
    const events: HeadlessStreamEvent[] = []
    await expect(new OpenRouterProvider().generate(baseInput(true), e => events.push(e))).rejects.toThrow(/403/)

    const limit = events.filter(e => e.type === 'generation_limit_reached')
    expect(limit).toHaveLength(1)
    expect(limit[0]).toEqual({ type: 'generation_limit_reached', message: 'Upgrade' })
  })

  it('does NOT emit generation_limit_reached on a 403 when the flag is unset, and throws the same error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => makeErrorResponse(403, JSON.stringify({ error: 'generation_limit_reached', message: 'Upgrade' })))
    )
    const events: HeadlessStreamEvent[] = []
    await expect(new OpenRouterProvider().generate(baseInput(false), e => events.push(e))).rejects.toThrow(
      /Railway OpenRouter request failed \(403\)/
    )

    expect(events.filter(e => e.type === 'generation_limit_reached')).toHaveLength(0)
  })
})
