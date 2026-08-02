import express from 'express'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerChatRoutes } from '../chatRoutes.js'

describe('registerChatRoutes', () => {
  let appServer: Server
  let baseUrl = ''
  const seenOperations: string[] = []
  const seenRequests: any[] = []
  const seenCompactionRequests: any[] = []

  beforeEach(() => {
    seenOperations.length = 0
    seenRequests.length = 0
    seenCompactionRequests.length = 0

    const app = express()
    app.use(express.json())

    registerChatRoutes(app, {
      orchestrator: {
        async runMessage(request, emit) {
          seenOperations.push(request.operation)
          seenRequests.push(request)
          emit({
            type: 'started',
            operation: request.operation,
            conversationId: request.conversationId,
            parentId: request.parentId,
            provider: request.provider,
            modelName: request.modelName,
          })
          emit({ type: 'chunk', part: 'text', delta: 'hello' })
          emit({ type: 'complete', message: { id: 'assistant-1' } })
        },
      },
      compactionService: {
        async compactBranch(request) {
          seenCompactionRequests.push(request)
          return {
            message: {
              id: 'compact-1',
              role: 'system',
              note: '__auto_compaction_summary__',
              parent_id: request.parentMessageId,
              content: 'summary',
            },
          }
        },
      } as any,
    })

    appServer = app.listen(0)
    const address = appServer.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      appServer.close(error => {
        if (error) reject(error)
        else resolve()
      })
    })
  })

  it('streams SSE events from orchestrator', async () => {
    const res = await fetch(`${baseUrl}/api/conversations/c1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'test' }),
    })

    expect(res.status).toBe(200)

    const raw = await res.text()
    const dataLines = raw
      .split('\n')
      .filter(line => line.startsWith('data: '))
      .map(line => JSON.parse(line.slice('data: '.length)))

    expect(dataLines[0]).toMatchObject({
      type: 'started',
      conversationId: 'c1',
      provider: 'openaichatgpt',
      modelName: 'gpt-5.6-sol',
    })
    expect(dataLines[1]).toMatchObject({ type: 'chunk', part: 'text', delta: 'hello' })
    expect(dataLines[2]).toMatchObject({ type: 'complete', message: { id: 'assistant-1' } })
    expect(seenOperations).toEqual(['send'])
  })

  it('maps endpoints to continuation operations', async () => {
    await fetch(`${baseUrl}/api/conversations/c1/messages/repeat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageId: 'm1' }),
    })

    await fetch(`${baseUrl}/api/conversations/c1/messages/m1/branch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'branch text' }),
    })

    await fetch(`${baseUrl}/api/conversations/c1/messages/m1/edit-branch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'edited branch text' }),
    })

    expect(seenOperations).toEqual(['repeat', 'branch', 'edit-branch'])
  })

  it('forwards optional content-lineage and fork-operation identities without conflating stream identity', async () => {
    await fetch(`${baseUrl}/api/conversations/c1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: 'test',
        lineage_id: 'lineage-1',
        operationId: 'operation-1',
        stream_id: 'stream-1',
      }),
    })

    expect(seenRequests[0]).toMatchObject({
      lineageId: 'lineage-1',
      operationId: 'operation-1',
      streamId: 'stream-1',
    })
  })

  it('forwards operation mode prompt settings', async () => {
    await fetch(`${baseUrl}/api/conversations/c1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: 'test',
        operationMode: 'plan',
        includeOperationModePrompt: false,
      }),
    })

    expect(seenRequests[0]).toMatchObject({
      operationMode: 'plan',
      includeOperationModePrompt: false,
    })
  })

  it('maps compact route to compaction service', async () => {
    const res = await fetch(`${baseUrl}/api/conversations/c1/compact`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        parentMessageId: 'm2',
        messages: [
          { id: 'm1', role: 'user', content: 'hello' },
          { id: 'm2', role: 'assistant', content: 'world' },
        ],
        provider: 'openaichatgpt',
        modelName: 'gpt-test',
        userId: 'u1',
      }),
    })

    expect(res.status).toBe(201)
    const payload = await res.json()
    expect(payload).toMatchObject({
      success: true,
      message: {
        id: 'compact-1',
        role: 'system',
        note: '__auto_compaction_summary__',
        parent_id: 'm2',
      },
    })
    expect(seenCompactionRequests[0]).toMatchObject({
      conversationId: 'c1',
      parentMessageId: 'm2',
      provider: 'openaichatgpt',
      modelName: 'gpt-test',
      userId: 'u1',
    })
  })
})
