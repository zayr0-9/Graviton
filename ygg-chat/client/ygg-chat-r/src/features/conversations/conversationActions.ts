import { createAsyncThunk } from '@reduxjs/toolkit'
import type { ConversationId, ProjectId } from '../../../../../shared/types'
import { RootState } from '../../store/store'
import { ThunkExtraArgument } from '../../store/thunkExtra'
import { gwApi, type SystemPromptPatchResponse } from '../../utils/api'
import { convContextSet, systemPromptSet } from './conversationSlice'
import { Conversation } from './conversationTypes'

// Thin client: every conversation CRUD/read goes through the local /api/gw/* gateway.

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
  },
  { state: RootState; extra: ThunkExtraArgument }
>(
  'conversations/create',
  async (
    { title, projectId: providedProjectId, systemPrompt, conversationContext, cwd },
    { getState, extra, rejectWithValue }
  ) => {
    try {
      const { auth } = extra
      if (!auth.userId) throw new Error('User not authenticated')

      const selectedProject = getState().projects.selectedProject
      const projectId = providedProjectId !== undefined ? providedProjectId : selectedProject?.id || null

      const projectForCwd = projectId ? getState().projects.projects.find(p => String(p.id) === String(projectId)) : null
      const effectiveCwd = cwd !== undefined ? cwd : projectForCwd?.cwd || null

      return await gwApi.post<Conversation>('/conversations', {
        userId: auth.userId,
        title: title || null,
        projectId,
        systemPrompt,
        conversationContext,
        cwd: effectiveCwd,
      })
    } catch (err) {
      return rejectWithValue(err instanceof Error ? err.message : 'Failed to create conversation')
    }
  }
)

// Update conversation title by id
export const updateConversation = createAsyncThunk<
  Conversation,
  { id: number | string; title: string },
  { extra: ThunkExtraArgument; state: RootState }
>('conversations/update', async ({ id, title }, { rejectWithValue }) => {
  try {
    return await gwApi.patch<Conversation>(`/conversations/${id}`, { title })
  } catch (err) {
    return rejectWithValue(err instanceof Error ? err.message : 'Failed to update conversation')
  }
})

// Delete conversation by id
export const deleteConversation = createAsyncThunk<
  ConversationId,
  { id: ConversationId },
  { extra: ThunkExtraArgument; state: RootState }
>('conversations/delete', async ({ id }, { rejectWithValue }) => {
  try {
    await gwApi.delete(`/conversations/${id}`)
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
  { id: ConversationId; systemPrompt: string | null },
  { extra: ThunkExtraArgument; state: RootState }
>('chat/updateSystemPrompt', async ({ id, systemPrompt }, { dispatch, rejectWithValue }) => {
  try {
    const updated = await gwApi.patch<any>(`/conversations/${id}/system-prompt`, { systemPrompt })
    dispatch(systemPromptSet(updated.system_prompt ?? null))
    return { id: updated.id, system_prompt: updated.system_prompt ?? null } as SystemPromptPatchResponse
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update system prompt'
    return rejectWithValue(message) as any
  }
})

export const updateContext = createAsyncThunk<
  { id: ConversationId; context: string | null },
  { id: ConversationId; context: string | null },
  { extra: ThunkExtraArgument; state: RootState }
>('chat/updateContext', async ({ id, context }, { dispatch, rejectWithValue }) => {
  try {
    const updated = await gwApi.patch<any>(`/conversations/${id}/context`, { context })
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
  { id: ConversationId; researchNote: string | null },
  { extra: ThunkExtraArgument; state: RootState }
>('conversations/updateResearchNote', async ({ id, researchNote }, { rejectWithValue }) => {
  try {
    return (await gwApi.patch<Conversation>(`/conversations/${id}/research-note`, { researchNote })) as Conversation
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update research note'
    return rejectWithValue(message) as any
  }
})

export const updateCwd = createAsyncThunk<
  Conversation,
  { id: ConversationId; cwd: string | null },
  { extra: ThunkExtraArgument; state: RootState }
>('conversations/updateCwd', async ({ id, cwd }, { rejectWithValue }) => {
  try {
    return (await gwApi.patch<Conversation>(`/conversations/${id}/cwd`, { cwd })) as Conversation
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update cwd'
    return rejectWithValue(message) as any
  }
})

// Extra working directories are host paths, stored on the local row only (cloud chats included).
export const updateAdditionalCwds = createAsyncThunk<
  Conversation,
  { id: ConversationId; additionalCwds: string[] },
  { extra: ThunkExtraArgument; state: RootState }
>('conversations/updateAdditionalCwds', async ({ id, additionalCwds }, { rejectWithValue }) => {
  try {
    return (await gwApi.patch<Conversation>(`/conversations/${id}/additional-cwds`, { additionalCwds })) as Conversation
  } catch (error) {
    return rejectWithValue(error instanceof Error ? error.message : 'Failed to update additional directories') as any
  }
})

/** Parses `additional_cwds`; NULL or malformed JSON means no extra directories. */
export const parseAdditionalCwds = (value: unknown): string[] => {
  if (typeof value !== 'string' || !value.trim()) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((root): root is string => typeof root === 'string' && root.trim().length > 0) : []
  } catch {
    return []
  }
}

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
