// server/routes/runStateRoutes.ts
//
// Local-only run-state persistence APIs, extracted verbatim from
// localServer.ts setupServer():
//   - streaming run lifecycle (durable stream ledger): /api/streaming/runs*
//     and /api/conversations/:conversationId/streaming-runs
//   - subagent run/transcript side channel: /api/subagents/* and
//     /api/conversations/:conversationId/subagents
//
// deps.statements is the prepared-statement bag built by
// initializeLocalDatabase(); registration happens after DB init.

import type { Express } from 'express'
import { SubagentRunRepo } from '../headlessServer/persistence/subagentRunRepo.js'

export interface RunStateRoutesDeps {
  statements: any
}

const safeJsonParseLocal = <T,>(value: any, fallback: T): T => {
  if (value == null) return fallback
  if (typeof value !== 'string') return value as T
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

// Subagent run/message normalization now lives in SubagentRunRepo (single
// source of truth shared with the headless subagent engine).

const normalizeStreamingRunRow = (row: any) => {
  if (!row) return null
  return {
    ...row,
    metadata: safeJsonParseLocal(row.metadata_json, null),
    duration_ms: row.duration_ms == null ? null : Number(row.duration_ms),
  }
}

const normalizeStreamingRunMetadata = (value: any): string | null => {
  if (value == null) return null
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return null
  }
}

const isTerminalStreamingRunStatus = (status: any): status is 'completed' | 'aborted' | 'error' =>
  status === 'completed' || status === 'aborted' || status === 'error'

const calculateStreamingRunDurationMs = (startedAt: any, endedAt: string | null): number | null => {
  if (!startedAt || !endedAt) return null
  const started = new Date(startedAt).getTime()
  const ended = new Date(endedAt).getTime()
  if (!Number.isFinite(started) || !Number.isFinite(ended)) return null
  return Math.max(0, ended - started)
}

// Lazily constructed after `statements` is initialized. Shared source of truth
// with the headless subagent engine for subagent_runs / subagent_messages.
let subagentRunRepoInstance: SubagentRunRepo | null = null

export function registerRunStateRoutes(app: Express, deps: RunStateRoutesDeps): void {
  const { statements } = deps

  const getSubagentRunRepo = (): SubagentRunRepo => {
    if (!subagentRunRepoInstance) {
      subagentRunRepoInstance = new SubagentRunRepo({ statements })
    }
    return subagentRunRepoInstance
  }

  // Streaming run lifecycle APIs (local-only durable stream ledger)
  app.post('/api/streaming/runs', (req, res) => {
    try {
      const body = req.body || {}
      const streamId = String(body.stream_id || body.streamId || '').trim()
      if (!streamId) {
        res.status(400).json({ error: 'stream_id is required' })
        return
      }

      const streamType = ['primary', 'branch', 'tool', 'subagent'].includes(body.stream_type || body.streamType)
        ? body.stream_type || body.streamType
        : 'primary'
      const status = ['running', 'completed', 'aborted', 'error'].includes(body.status) ? body.status : 'running'
      const source = ['renderer', 'headless', 'subagent', 'tool', 'unknown'].includes(body.source) ? body.source : 'renderer'
      const now = new Date().toISOString()
      const startedAt = body.started_at || body.startedAt || now
      const endedAt = body.ended_at || body.endedAt || (isTerminalStreamingRunStatus(status) ? now : null)
      const durationMs =
        typeof body.duration_ms === 'number'
          ? body.duration_ms
          : typeof body.durationMs === 'number'
            ? body.durationMs
            : calculateStreamingRunDurationMs(startedAt, endedAt)
      const metadataJson = normalizeStreamingRunMetadata(body.metadata_json ?? body.metadata)

      statements.upsertStreamingRun.run(
        streamId,
        body.conversation_id || body.conversationId || null,
        body.parent_message_id || body.parentMessageId || null,
        body.user_message_id || body.userMessageId || null,
        body.assistant_message_id || body.assistantMessageId || null,
        body.final_message_id || body.finalMessageId || null,
        streamType,
        status,
        body.end_reason || body.endReason || null,
        body.provider || null,
        body.model_name || body.modelName || null,
        body.operation || null,
        source,
        body.root_message_id || body.rootMessageId || null,
        body.origin_message_id || body.originMessageId || null,
        body.parent_stream_id || body.parentStreamId || null,
        body.tool_call_id || body.toolCallId || null,
        body.error || null,
        metadataJson,
        startedAt,
        endedAt,
        durationMs,
        body.created_at || body.createdAt || now,
        now
      )

      const run = statements.getStreamingRunById.get(streamId)
      res.json({ run: normalizeStreamingRunRow(run) })
    } catch (error) {
      console.error('[LocalServer] Error upserting streaming run:', error)
      res.status(500).json({ error: 'Failed to upsert streaming run' })
    }
  })

  app.patch('/api/streaming/runs/:streamId', (req, res) => {
    try {
      const { streamId } = req.params
      const existing = statements.getStreamingRunById.get(streamId)
      if (!existing) {
        res.status(404).json({ error: 'Streaming run not found' })
        return
      }

      const body = req.body || {}
      const status = ['running', 'completed', 'aborted', 'error'].includes(body.status) ? body.status : null
      const endedAt = body.ended_at || body.endedAt || (isTerminalStreamingRunStatus(status) ? new Date().toISOString() : null)
      const durationMs =
        typeof body.duration_ms === 'number'
          ? body.duration_ms
          : typeof body.durationMs === 'number'
            ? body.durationMs
            : calculateStreamingRunDurationMs(existing.started_at, endedAt)
      const metadataJson = normalizeStreamingRunMetadata(body.metadata_json ?? body.metadata)
      const now = new Date().toISOString()

      statements.updateStreamingRun.run(
        status,
        body.end_reason || body.endReason || null,
        body.assistant_message_id || body.assistantMessageId || null,
        body.final_message_id || body.finalMessageId || null,
        body.user_message_id || body.userMessageId || null,
        body.error ?? null,
        metadataJson,
        endedAt,
        durationMs,
        now,
        streamId
      )

      const run = statements.getStreamingRunById.get(streamId)
      res.json({ run: normalizeStreamingRunRow(run) })
    } catch (error) {
      console.error('[LocalServer] Error updating streaming run:', error)
      res.status(500).json({ error: 'Failed to update streaming run' })
    }
  })

  app.get('/api/streaming/runs/:streamId', (req, res) => {
    try {
      const run = statements.getStreamingRunById.get(req.params.streamId)
      if (!run) {
        res.status(404).json({ error: 'Streaming run not found' })
        return
      }
      res.json({ run: normalizeStreamingRunRow(run) })
    } catch (error) {
      console.error('[LocalServer] Error fetching streaming run:', error)
      res.status(500).json({ error: 'Failed to fetch streaming run' })
    }
  })

  app.get('/api/conversations/:conversationId/streaming-runs', (req, res) => {
    try {
      const runs = statements.getStreamingRunsByConversationId.all(req.params.conversationId).map(normalizeStreamingRunRow)
      res.json({ runs })
    } catch (error) {
      console.error('[LocalServer] Error fetching conversation streaming runs:', error)
      res.status(500).json({ error: 'Failed to fetch conversation streaming runs' })
    }
  })

  // Subagent run/transcript APIs (local-only side channel; not part of main message tree)
  app.post('/api/subagents/runs', (req, res) => {
    try {
      const {
        id,
        conversation_id,
        conversationId,
        parent_message_id,
        parentMessageId,
        tool_call_id,
        toolCallId,
        prompt,
        provider,
        model_name,
        modelName,
        system_prompt,
        systemPrompt,
        status,
      } = req.body || {}

      const resolvedConversationId = String(conversation_id || conversationId || '').trim()
      const resolvedParentMessageId = String(parent_message_id || parentMessageId || '').trim()
      const resolvedPrompt = typeof prompt === 'string' ? prompt : ''

      if (!resolvedConversationId) {
        res.status(400).json({ error: 'conversation_id is required' })
        return
      }
      if (!resolvedParentMessageId) {
        res.status(400).json({ error: 'parent_message_id is required' })
        return
      }
      if (!resolvedPrompt.trim()) {
        res.status(400).json({ error: 'prompt is required' })
        return
      }

      const run = getSubagentRunRepo().createRun({
        id: typeof id === 'string' && id.trim() ? id.trim() : undefined,
        conversationId: resolvedConversationId,
        parentMessageId: resolvedParentMessageId,
        toolCallId: tool_call_id || toolCallId || null,
        prompt: resolvedPrompt,
        provider: provider || null,
        modelName: model_name || modelName || null,
        systemPrompt: system_prompt || systemPrompt || null,
        status: status || 'running',
      })
      res.json({ run })
    } catch (error) {
      console.error('[LocalServer] Error creating subagent run:', error)
      res.status(500).json({ error: 'Failed to create subagent run' })
    }
  })

  app.post('/api/subagents/runs/:runId/messages', (req, res) => {
    try {
      const { runId } = req.params
      const repo = getSubagentRunRepo()
      if (!repo.getRunById(runId)) {
        res.status(404).json({ error: 'Subagent run not found' })
        return
      }

      const { id, role, content, thinking_block, thinkingBlock, tool_calls, toolCalls, tool_call_id, toolCallId, content_blocks, contentBlocks, sequence, created_at, createdAt } = req.body || {}
      const resolvedRole = typeof role === 'string' ? role : ''
      if (!['user', 'assistant', 'tool', 'system'].includes(resolvedRole)) {
        res.status(400).json({ error: 'Invalid role' })
        return
      }

      repo.appendMessage(runId, {
        id: typeof id === 'string' && id.trim() ? id.trim() : undefined,
        role: resolvedRole as any,
        content: typeof content === 'string' ? content : content == null ? '' : JSON.stringify(content),
        thinkingBlock: thinking_block || thinkingBlock || null,
        toolCalls: typeof tool_calls === 'string' ? tool_calls : tool_calls ?? toolCalls ?? null,
        toolCallId: tool_call_id || toolCallId || null,
        contentBlocks: typeof content_blocks === 'string' ? content_blocks : content_blocks ?? contentBlocks ?? null,
        sequence: typeof sequence === 'number' && Number.isFinite(sequence) ? sequence : undefined,
        createdAt: created_at || createdAt || undefined,
      })

      const messages = repo.getMessages(runId)
      const messageId = typeof id === 'string' && id.trim() ? id.trim() : messages[messages.length - 1]?.id
      res.json({ message: messages.find((m: any) => m.id === messageId), messages })
    } catch (error) {
      console.error('[LocalServer] Error appending subagent message:', error)
      res.status(500).json({ error: 'Failed to append subagent message' })
    }
  })

  app.patch('/api/subagents/runs/:runId', (req, res) => {
    try {
      const { runId } = req.params
      const { status, final_response, finalResponse, error, turns_used, turnsUsed, tool_calls_used, toolCallsUsed } = req.body || {}
      const run = getSubagentRunRepo().updateRun(runId, {
        status: status || null,
        finalResponse: final_response ?? finalResponse ?? null,
        error: error ?? null,
        turnsUsed: typeof turns_used === 'number' ? turns_used : typeof turnsUsed === 'number' ? turnsUsed : null,
        toolCallsUsed: typeof tool_calls_used === 'number' ? tool_calls_used : typeof toolCallsUsed === 'number' ? toolCallsUsed : null,
      })
      if (!run) {
        res.status(404).json({ error: 'Subagent run not found' })
        return
      }
      res.json({ run })
    } catch (err) {
      console.error('[LocalServer] Error updating subagent run:', err)
      res.status(500).json({ error: 'Failed to update subagent run' })
    }
  })

  app.get('/api/subagents/by-parent/:messageId', (req, res) => {
    try {
      res.json({ runs: getSubagentRunRepo().listByParentMessage(req.params.messageId) })
    } catch (error) {
      console.error('[LocalServer] Error fetching subagent runs by parent:', error)
      res.status(500).json({ error: 'Failed to fetch subagent runs' })
    }
  })

  app.get('/api/conversations/:conversationId/subagents', (req, res) => {
    try {
      res.json({ runs: getSubagentRunRepo().listByConversation(req.params.conversationId) })
    } catch (error) {
      console.error('[LocalServer] Error fetching conversation subagents:', error)
      res.status(500).json({ error: 'Failed to fetch conversation subagents' })
    }
  })
}
