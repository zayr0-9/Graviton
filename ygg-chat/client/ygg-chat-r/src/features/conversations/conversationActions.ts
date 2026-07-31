import { createAsyncThunk } from '@reduxjs/toolkit'
import type { ConversationId, ProjectId } from '../../../../../shared/types'
import { RootState } from '../../store/store'
import { ThunkExtraArgument } from '../../store/thunkExtra'
import { isCommunityMode } from '../../config/runtimeMode'
import { gwApi, environment, type SystemPromptPatchResponse } from '../../utils/api'
import { convContextSet, systemPromptSet } from './conversationSlice'
import { Conversation } from './conversationTypes'

/**
 * Authoritative storage-mode hint for gateway writes. The renderer knows a
 * conversation's storage mode (from the caller or Redux), so passing it as
 * ?storageMode= lets the gateway route the write to the correct leg without
 * having to guess from a possibly-stale local mirror row.
 */
function storageModeQs(
  getState: () => RootState,
  id: ConversationId | number,
  storageMode?: 'cloud' | 'local'
): string {
  const mode = storageMode || getState().conversations.items.find(c => String(c.id) === String(id))?.storage_mode
  return mode ? `?storageMode=${mode}` : ''
}

// Phase 5: the renderer is a thin client. Every CRUD/read goes through the
// storage-aware /api/gw/* gateway (gwApi → :3002), which owns the local-vs-cloud
// branch, the local+cloud read merge, and the cloud→SQLite mirror (dual-write).
// No more shouldUseLocalApi branching or dualSyncManager calls here.

// Fetch conversations for current user
export const fetchConversations = createAsyncThunk<
  Conversation[],
  void,
  { state: RootState; extra: ThunkExtraArgument }
>('conversations/fetchAll', async (_: void, { extra, rejectWithValue }) => {
  try {
    const { auth } = extra
    if (!auth.userId) throw new Error('User not authenticated')
    return await gwApi.get<Conversation[]>(`/conversations?userId=${auth.userId}`)
  } catch (err) {
    return rejectWithValue(err instanceof Error ? err.message : 'Failed to fetch conversations')
  }
})

// Fetch recent conversations for current user with limit
export const fetchRecentConversations = createAsyncThunk<
  Conversation[],
  { limit?: number },
  { state: RootState; extra: ThunkExtraArgument }
>('conversations/fetchRecent', async ({ limit = 10 } = {}, { extra, rejectWithValue }) => {
  try {
    const { auth } = extra
    if (!auth.userId) throw new Error('User not authenticated')
    const query = new URLSearchParams({ userId: String(auth.userId), limit: String(limit) }).toString()
    return await gwApi.get<Conversation[]>(`/conversations/recent?${query}`)
  } catch (err) {
    return rejectWithValue(err instanceof Error ? err.message : 'Failed to fetch recent conversations')
  }
})

// Fetch conversations by project ID
export const fetchConversationsByProjectId = createAsyncThunk<Conversation[], ProjectId, { extra: ThunkExtraArgument }>(
  'conversations/fetchByProjectId',
  async (projectId: ProjectId, { extra, rejectWithValue }) => {
    try {
      const { auth } = extra
      if (!auth.userId) throw new Error('User not authenticated')
      // The gateway returns the merged (local+cloud) list; filter to this project.
      const all = await gwApi.get<Conversation[]>(`/conversations?userId=${auth.userId}`)
      return all.filter(conversation => String(conversation.project_id) === String(projectId))
    } catch (err) {
      return rejectWithValue(err instanceof Error ? err.message : 'Failed to fetch conversations by project')
    }
  }
)

// Create new conversation for current user
export const createConversation = createAsyncThunk<
  Conversation,
  {
    title?: string
    projectId?: string | null
    systemPrompt?: string | null
    conversationContext?: string | null
    cwd?: string | null
    storageMode?: 'cloud' | 'local'
  },
  { state: RootState; extra: ThunkExtraArgument }
>(
  'conversations/create',
  async (
    { title, projectId: providedProjectId, systemPrompt, conversationContext, cwd, storageMode },
    { getState, extra, rejectWithValue }
  ) => {
    try {
      const { auth } = extra
      if (!auth.userId) throw new Error('User not authenticated')

      const isCommunity = environment === 'electron' && isCommunityMode
      const selectedProject = getState().projects.selectedProject
      const projectId = providedProjectId !== undefined ? providedProjectId : selectedProject?.id || null

      const requestedStorageMode = isCommunity ? 'local' : storageMode

      // Determine storage mode from project if not explicitly provided.
      let effectiveStorageMode = requestedStorageMode
      if (!effectiveStorageMode && projectId) {
        const project = getState().projects.projects.find(p => p.id === projectId)
        effectiveStorageMode = project?.storage_mode || (isCommunity ? 'local' : 'cloud')
      }
      effectiveStorageMode = effectiveStorageMode || (isCommunity ? 'local' : 'cloud')

      // VALIDATION: a provided project + explicit storage mode must agree, so we never
      // mix a cloud project with a local conversation.
      if (projectId && requestedStorageMode) {
        const project = getState().projects.projects.find(p => p.id === projectId)
        if (project && project.storage_mode !== requestedStorageMode) {
          throw new Error(
            `Storage mode mismatch: Cannot create ${requestedStorageMode} conversation in ${project.storage_mode} project. ` +
              `Conversations must use the same storage location as their project.`
          )
        }
      }

      const projectForCwd = projectId ? getState().projects.projects.find(p => String(p.id) === String(projectId)) : null
      const effectiveCwd = cwd !== undefined ? cwd : projectForCwd?.cwd || null

      // Canonical (camelCase) body; the gateway normalizes per storage leg + mirrors.
      return await gwApi.post<Conversation>('/conversations', {
        userId: auth.userId,
        title: title || null,
        projectId,
        systemPrompt,
        conversationContext,
        cwd: effectiveCwd,
        storageMode: effectiveStorageMode,
      })
    } catch (err) {
      return rejectWithValue(err instanceof Error ? err.message : 'Failed to create conversation')
    }
  }
)

// Update conversation title by id
export const updateConversation = createAsyncThunk<
  Conversation,
  { id: number | string; title: string; storageMode?: 'cloud' | 'local' },
  { extra: ThunkExtraArgument; state: RootState }
>('conversations/update', async ({ id, title, storageMode }, { getState, rejectWithValue }) => {
  try {
    return await gwApi.patch<Conversation>(`/conversations/${id}${storageModeQs(getState, id, storageMode)}`, { title })
  } catch (err) {
    return rejectWithValue(err instanceof Error ? err.message : 'Failed to update conversation')
  }
})

// Delete conversation by id
export const deleteConversation = createAsyncThunk<
  ConversationId,
  { id: ConversationId; storageMode?: 'cloud' | 'local' },
  { extra: ThunkExtraArgument; state: RootState }
>('conversations/delete', async ({ id, storageMode }, { getState, rejectWithValue }) => {
  try {
    await gwApi.delete(`/conversations/${id}${storageModeQs(getState, id, storageMode)}`)
    return id
  } catch (err) {
    return rejectWithValue(err instanceof Error ? err.message : 'Failed to delete conversation')
  }
})

// Fetch the conversation system prompt and store in state.chat.systemPrompt
export const fetchSystemPrompt = createAsyncThunk<string | null, ConversationId, { extra: ThunkExtraArgument }>(
  'chat/fetchSystemPrompt',
  async (conversationId, { dispatch, rejectWithValue }) => {
    try {
      const res = await gwApi.get<{ systemPrompt: string | null }>(`/conversations/${conversationId}/system-prompt`)
      const value = typeof res.systemPrompt === 'string' ? res.systemPrompt : null
      dispatch(systemPromptSet(value))
      return value
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to fetch system prompt'
      return rejectWithValue(message) as any
    }
  }
)

// Fetch conversation context
export const fetchContext = createAsyncThunk<string | null, ConversationId, { extra: ThunkExtraArgument }>(
  'chat/fetchContext',
  async (conversationId, { dispatch, rejectWithValue }) => {
    try {
      const res = await gwApi.get<{ context: string | null }>(`/conversations/${conversationId}/context`)
      const value = res.context ?? null
      dispatch(convContextSet(value))
      return value
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to fetch context'
      return rejectWithValue(message) as any
    }
  }
)

// Update the conversation system prompt on the server and reflect in state
export const updateSystemPrompt = createAsyncThunk<
  SystemPromptPatchResponse,
  { id: ConversationId; systemPrompt: string | null; storageMode?: 'cloud' | 'local' },
  { extra: ThunkExtraArgument; state: RootState }
>('chat/updateSystemPrompt', async ({ id, systemPrompt, storageMode }, { dispatch, getState, rejectWithValue }) => {
  try {
    const updated = await gwApi.patch<any>(`/conversations/${id}/system-prompt${storageModeQs(getState, id, storageMode)}`, { systemPrompt })
    dispatch(systemPromptSet(updated.system_prompt ?? null))
    return { id: updated.id, system_prompt: updated.system_prompt ?? null } as SystemPromptPatchResponse
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update system prompt'
    return rejectWithValue(message) as any
  }
})

export const updateContext = createAsyncThunk<
  { id: ConversationId; context: string | null },
  { id: ConversationId; context: string | null; storageMode?: 'cloud' | 'local' },
  { extra: ThunkExtraArgument; state: RootState }
>('chat/updateContext', async ({ id, context, storageMode }, { dispatch, getState, rejectWithValue }) => {
  try {
    const updated = await gwApi.patch<any>(`/conversations/${id}/context${storageModeQs(getState, id, storageMode)}`, { context })
    const next = { id: updated.id, context: updated.conversation_context ?? null }
    dispatch(convContextSet(next.context))
    return next
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update context'
    return rejectWithValue(message) as any
  }
})

export const updateResearchNote = createAsyncThunk<
  Conversation,
  { id: ConversationId; researchNote: string | null; storageMode?: 'cloud' | 'local' },
  { extra: ThunkExtraArgument; state: RootState }
>('conversations/updateResearchNote', async ({ id, researchNote, storageMode }, { getState, rejectWithValue }) => {
  try {
    return (await gwApi.patch<Conversation>(`/conversations/${id}/research-note${storageModeQs(getState, id, storageMode)}`, { researchNote })) as Conversation
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update research note'
    return rejectWithValue(message) as any
  }
})

export const updateCwd = createAsyncThunk<
  Conversation,
  { id: ConversationId; cwd: string | null; storageMode?: 'cloud' | 'local' },
  { extra: ThunkExtraArgument; state: RootState }
>('conversations/updateCwd', async ({ id, cwd, storageMode }, { getState, rejectWithValue }) => {
  try {
    return (await gwApi.patch<Conversation>(`/conversations/${id}/cwd${storageModeQs(getState, id, storageMode)}`, { cwd })) as Conversation
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update cwd'
    return rejectWithValue(message) as any
  }
})

// Search conversations by title from the server (gateway merges local + cloud).
export const searchConversations = createAsyncThunk<
  Conversation[],
  { query: string; projectId?: ProjectId | null; limit?: number },
  { extra: ThunkExtraArgument }
>('conversations/search', async ({ query, projectId, limit = 20 }, { extra, rejectWithValue }) => {
  try {
    const { auth } = extra
    if (!auth.userId) throw new Error('User not authenticated')
    const params = new URLSearchParams({ userId: String(auth.userId), q: query, limit: String(limit) })
    if (projectId) params.set('projectId', String(projectId))
    return await gwApi.get<Conversation[]>(`/conversations/search?${params.toString()}`)
  } catch (err) {
    return rejectWithValue(err instanceof Error ? err.message : 'Failed to search conversations')
  }
})
