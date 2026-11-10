import { isNativeShell } from '../../platform/clientCapabilities'
import { localApi } from '../../utils/api'
import type { StreamUndoSummary } from './chatTypes'

const isElectron = () => isNativeShell

export async function fetchConversationUndoSummaries(conversationId: string): Promise<StreamUndoSummary[]> {
  if (!isElectron() || !conversationId) return []
  const response = await localApi.get<{ success: boolean; summaries?: StreamUndoSummary[]; error?: string }>(
    `/undo/conversations/${encodeURIComponent(conversationId)}`
  )
  if (!response.success) throw new Error(response.error || 'Failed to fetch undo summaries')
  return response.summaries || []
}

export async function fetchStreamUndoSummary(streamId: string): Promise<StreamUndoSummary | null> {
  if (!isElectron() || !streamId) return null
  const response = await localApi.get<{ success: boolean; summary?: StreamUndoSummary; error?: string }>(
    `/undo/streams/${encodeURIComponent(streamId)}`
  )
  if (!response.success) throw new Error(response.error || 'Failed to fetch undo summary')
  return response.summary || null
}

export async function markStreamUndoFinalMessage(
  streamId: string,
  assistantMessageId: string | null
): Promise<StreamUndoSummary | null> {
  if (!isElectron() || !streamId) return null
  const response = await localApi.post<{ success: boolean; summary?: StreamUndoSummary; error?: string }>(
    `/undo/streams/${encodeURIComponent(streamId)}/final-message`,
    { assistantMessageId }
  )
  if (!response.success) throw new Error(response.error || 'Failed to mark undo final message')
  return response.summary || null
}

export async function restoreStreamUndo(
  streamId: string,
  options: { force?: boolean; expectedParentMessageId?: string | null } = {}
): Promise<{ success: boolean; manifest?: StreamUndoSummary; conflicts?: any[]; error?: string }> {
  if (!isElectron() || !streamId) return { success: false, error: 'Undo is only available in Electron mode' }
  return await localApi.post(`/undo/streams/${encodeURIComponent(streamId)}/restore`, options)
}
