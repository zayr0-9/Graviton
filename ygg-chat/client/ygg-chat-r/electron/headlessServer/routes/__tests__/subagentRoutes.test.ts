import express from 'express'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerSubagentRoutes } from '../subagentRoutes.js'
import type { SubagentRunService } from '../../services/subagentRunService.js'

describe('registerSubagentRoutes', () => {
  let appServer: Server
  let baseUrl = ''
  let seenRequests: any[]
  let runImpl: (request: any, emit: (event: any) => void, signal: AbortSignal) => Promise<void>
  let listByToolCallImpl: (toolCallId: string) => any[]

  const validBody = () => ({
    conversationId: 'c1',
    parentMessageId: 'p1',
    prompt: 'do the task',
    provider: 'openaichatgpt',
    modelName: 'gpt-5.6-sol',
    autoApprove: true,
  })

  beforeEach(() => {
    seenRequests = []
    listByToolCallImpl = () => []
    runImpl = async (request, emit) => {
      emit({
        type: 'started',
        operation: 'subagent',
        subagentRunId: 'run-1',
        streamId: 'sub-stream-1',
        conversationId: request.conversationId,
        parentMessageId: request.parentMessageId,
        provider: request.provider,
        modelName: request.modelName,
        maxTurns: 120,
        resolvedToolNames: ['read_file'],
      })
      emit({ type: 'chunk', part: 'text', delta: 'hi' })
      emit({
        type: 'complete',
        subagentRunId: 'run-1',
        result: 'final text',
        stats: { turnsUsed: 1, maxTurns: 120, toolCallsUsed: 0, toolsExecuted: [] },
      })
    }

    const app = express()
    app.use(express.json())
    registerSubagentRoutes(app, {
      runService: {
        run: (request: any, emit: any, signal: any) => {
          seenRequests.push(request)
          return runImpl(request, emit, signal)
        },
        listByToolCall: (toolCallId: string) => listByToolCallImpl(toolCallId),
      } as unknown as SubagentRunService,
      validateTarget: (conversationId, parentMessageId) => {
        if (conversationId === 'missing-convo') return { status: 404, error: 'Conversation not found' }
        if (parentMessageId === 'missing-parent') return { status: 404, error: 'Parent message not found' }
        return null
      },
    })

    appServer = app.listen(0)
    baseUrl = `http://127.0.0.1:${(appServer.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      appServer.close(error => (error ? reject(error) : resolve()))
    })
  })

  const parseSse = (raw: string) =>
    raw
      .split('\n')
      .filter(line => line.startsWith('data: '))
      .map(line => JSON.parse(line.slice('data: '.length)))

  it('streams started -> chunk -> complete', async () => {
    const res = await fetch(`${baseUrl}/api/headless/subagent/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validBody()),
    })

    expect(res.status).toBe(200)
    const events = parseSse(await res.text())
    expect(events[0]).toMatchObject({ type: 'started', subagentRunId: 'run-1', resolvedToolNames: ['read_file'] })
    expect(events[1]).toMatchObject({ type: 'chunk', part: 'text', delta: 'hi' })
    expect(events[2]).toMatchObject({ type: 'complete', result: 'final text' })
  })

  it('normalizes the request body (tool names, autoApprove, streamId, lineageId)', async () => {
    await fetch(`${baseUrl}/api/headless/subagent/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...validBody(),
        streamId: 'parent-s',
        lineage_id: 'content-lineage-1',
        tools: ['read_file', { name: 'ripgrep' }],
        autoApprove: false,
      }),
    })
    expect(seenRequests[0]).toMatchObject({
      streamId: 'parent-s',
      lineageId: 'content-lineage-1',
      tools: ['read_file', 'ripgrep'],
      autoApprove: false,
    })
  })

  it('rejects missing prompt / conversationId / parentMessageId with 400', async () => {
    for (const patch of [{ prompt: '' }, { conversationId: '' }, { parentMessageId: '' }]) {
      const res = await fetch(`${baseUrl}/api/headless/subagent/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...validBody(), ...patch }),
      })
      expect(res.status).toBe(400)
    }
    expect(seenRequests).toHaveLength(0)
  })

  it('rejects openrouter provider with 400', async () => {
    const res = await fetch(`${baseUrl}/api/headless/subagent/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...validBody(), provider: 'openrouter' }),
    })
    expect(res.status).toBe(400)
    expect(seenRequests).toHaveLength(0)
  })

  it('returns 404 when the target does not exist', async () => {
    const res = await fetch(`${baseUrl}/api/headless/subagent/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...validBody(), conversationId: 'missing-convo' }),
    })
    expect(res.status).toBe(404)
    expect(seenRequests).toHaveLength(0)
  })

  it('emits an SSE error when the engine throws', async () => {
    runImpl = async () => {
      throw new Error('engine exploded')
    }
    const res = await fetch(`${baseUrl}/api/headless/subagent/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validBody()),
    })
    expect(res.status).toBe(200)
    const events = parseSse(await res.text())
    expect(events.some(e => e.type === 'error' && e.error === 'engine exploded')).toBe(true)
  })

  it('GET by-tool-call returns the runs (with transcripts) for a tool call', async () => {
    let seenToolCallId = ''
    listByToolCallImpl = toolCallId => {
      seenToolCallId = toolCallId
      return [
        {
          id: 'run-1',
          tool_call_id: 'tc-1',
          status: 'completed',
          final_response: 'done',
          messages: [
            { id: 'm1', role: 'user', content: 'go', sequence: 0 },
            { id: 'm2', role: 'assistant', content: 'done', sequence: 1 },
          ],
        },
      ]
    }
    const res = await fetch(`${baseUrl}/api/subagents/by-tool-call/tc-1`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(seenToolCallId).toBe('tc-1')
    expect(body.runs).toHaveLength(1)
    expect(body.runs[0]).toMatchObject({ id: 'run-1', status: 'completed' })
    expect(body.runs[0].messages).toHaveLength(2)
  })

  it('GET by-tool-call returns an empty array when no runs match', async () => {
    listByToolCallImpl = () => []
    const res = await fetch(`${baseUrl}/api/subagents/by-tool-call/unknown-tc`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.runs).toEqual([])
  })

  it('aborts the engine signal when the client disconnects', async () => {
    let abortObserved = false
    runImpl = async (_request, emit, signal) => {
      emit({ type: 'started', operation: 'subagent', subagentRunId: 'run-1', streamId: 's', conversationId: 'c1', parentMessageId: 'p1', provider: 'openaichatgpt', modelName: 'gpt-5.6-sol', maxTurns: 120, resolvedToolNames: [] })
      await new Promise<void>(resolve => {
        if (signal.aborted) {
          abortObserved = true
          resolve()
          return
        }
        signal.addEventListener('abort', () => {
          abortObserved = true
          resolve()
        })
      })
    }

    const controller = new AbortController()
    const req = fetch(`${baseUrl}/api/headless/subagent/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validBody()),
      signal: controller.signal,
    }).catch(() => undefined)

    // Give the server time to start streaming, then disconnect.
    await new Promise(resolve => setTimeout(resolve, 100))
    controller.abort()
    await req

    // Wait for the server to observe the close.
    for (let i = 0; i < 50 && !abortObserved; i++) {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    expect(abortObserved).toBe(true)
  })
})
