import { createAsyncThunk } from '@reduxjs/toolkit'
import type { ConversationId, ProjectId } from '../../../../../shared/types'
import { RootState } from '../../store/store'
import { ThunkExtraArgument } from '../../store/thunkExtra'
import { isCommunityMode, isElectronMode } from '../../config/runtimeMode'
import {
  api,
  localApi,
  environment,
  shouldUseLocalApi,
  getConversationContext,
  getConversationSystemPrompt,
  patchConversationContext,
  patchConversationResearchNote,
  patchConversationCwd,
  patchConversationSystemPrompt,
  type SystemPromptPatchResponse,
} from '../../utils/api'
import { convContextSet, systemPromptSet } from './conversationSlice'
import { Conversation } from './conversationTypes'
import { dualSync } from '../../lib/sync/dualSyncManager'

const isElectronCommunityMode = () => isElectronMode && isCommunityMode

// Fetch conversations for current user
// Note: fetchRecentModels has been migrated to React Query (see useRecentModels in hooks/useQueries.ts)

export const fetchConversations = createAsyncThunk<
  Conversation[],
  void,
  { state: RootState; extra: ThunkExtraArgument }
>('conversations/fetchAll', async (_: void, { extra, rejectWithValue }) => {
  try {
    const { auth } = extra

    if (!auth.userId) {
      throw new Error('User not authenticated')
    }

    if (isElectronCommunityMode()) {
      return await localApi.get<Conversation[]>(`/app/conversations?userId=${auth.userId}`)
    }

    // In Electron mode, fetch both cloud and local conversations
    if (environment === 'electron') {
      const [cloudConversations, localConversations] = await Promise.all([
        api.get<Conversation[]>(`/users/${auth.userId}/conversations`, auth.accessToken),
        localApi.get<Conversation[]>(`/app/conversations?userId=${auth.userId}`),
      ])

      // Merge and sort by updated_at
      const merged = [...cloudConversations, ...localConversations].sort(
        (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
      )

      return merged
    }

    // Web mode: cloud only
    return await api.get<Conversation[]>(`/users/${auth.userId}/conversations`, auth.accessToken)
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

    if (!auth.userId) {
      throw new Error('User not authenticated')
    }

    if (isElectronCommunityMode()) {
      const localConversations = await localApi.get<Conversation[]>(`/app/conversations?userId=${auth.userId}`)
      return [...localConversations]
        .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
        .slice(0, limit)
    }

    const query = new URLSearchParams({ limit: String(limit) }).toString()
    return await api.get<Conversation[]>(`/users/${auth.userId}/conversations/recent?${query}`, auth.accessToken)
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

      if (isElectronCommunityMode()) {
        const localConversations = await localApi.get<Conversation[]>(`/app/conversations?userId=${auth.userId}`)
        return localConversations.filter(conversation => String(conversation.project_id) === String(projectId))
      }

      return await api.get<Conversation[]>(`/conversations/project/${projectId}`, auth.accessToken)
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
    storageMode?: 'cloud' | 'local' // NEW PARAMETER
  },
  { state: RootState; extra: ThunkExtraArgument }
>(
  'conversations/create',
  async (
    { title, projectId: providedProjectId, systemPrompt, conversationContext, storageMode },
    { getState, extra, rejectWithValue }
  ) => {
    try {
      const { auth } = extra

      if (!auth.userId) {
        throw new Error('User not authenticated')
      }

      // Use provided projectId if available, otherwise fall back to selected project from state
      const selectedProject = getState().projects.selectedProject
      const projectId = providedProjectId !== undefined ? providedProjectId : selectedProject?.id || null

      const requestedStorageMode = isElectronCommunityMode() ? 'local' : storageMode

      // Determine storage mode from project if not explicitly provided
      let effectiveStorageMode = requestedStorageMode
      if (!effectiveStorageMode && projectId) {
        const project = getState().projects.projects.find(p => p.id === projectId)
        effectiveStorageMode = project?.storage_mode || (isElectronCommunityMode() ? 'local' : 'cloud')
      }
      effectiveStorageMode = effectiveStorageMode || (isElectronCommunityMode() ? 'local' : 'cloud')

      // VALIDATION: If project is provided and storage mode is explicitly set,
      // ensure they match to prevent mixing cloud projects with local conversations
      if (projectId && requestedStorageMode) {
        const project = getState().projects.projects.find(p => p.id === projectId)
        if (project && project.storage_mode !== requestedStorageMode) {
          throw new Error(
            `Storage mode mismatch: Cannot create ${requestedStorageMode} conversation in ${project.storage_mode} project. ` +
            `Conversations must use the same storage location as their project.`
          )
        }
      }

      // Route to local or cloud API
      if (shouldUseLocalApi(effectiveStorageMode, environment)) {
        const conversation = await localApi.post<Conversation>('/app/conversations', {
          user_id: auth.userId,
          title: title || null,
          project_id: projectId,
          system_prompt: systemPrompt,
          conversation_context: conversationContext,
          storage_mode: 'local'
        })
        return conversation
      }

      // Cloud mode: existing behavior
      const conversation = await api.post<Conversation>('/conversations', auth.accessToken, {
        userId: auth.userId,
        title: title || null,
        projectId,
        systemPrompt,
        conversationContext,
      })

      // Sync to local SQLite (fire-and-forget) - only for cloud mode
      dualSync.syncConversation({
        ...conversation,
        user_id: auth.userId,
        project_id: projectId,
        system_prompt: systemPrompt || null,
        conversation_context: conversationContext || null,
      })

      return conversation
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
>('conversations/update', async ({ id, title, storageMode }, { extra, getState, rejectWithValue }) => {
  try {
    const { auth } = extra

    // Infer storage mode from state if not provided
    let effectiveMode = storageMode
    if (!effectiveMode) {
      const conversation = getState().conversations.items.find(c => c.id === id)
      effectiveMode = conversation?.storage_mode || (isElectronCommunityMode() ? 'local' : 'cloud')
    }

    if (shouldUseLocalApi(effectiveMode, environment)) {
      const conversation = await localApi.patch<Conversation>(`/app/conversations/${id}`, { title })
      return conversation
    }

    const conversation = await api.patch<Conversation>(`/conversations/${id}/`, auth.accessToken, { title })

    // Sync to local SQLite (fire-and-forget)
    dualSync.syncConversation(conversation, 'update')

    return conversation
  } catch (err) {
    return rejectWithValue(err instanceof Error ? err.message : 'Failed to update conversation')
  }
})

// Delete conversation by id
export const deleteConversation = createAsyncThunk<
  ConversationId,
  { id: ConversationId; storageMode?: 'cloud' | 'local' }, // Add storageMode param
  { extra: ThunkExtraArgument; state: RootState }
>('conversations/delete', async ({ id, storageMode }, { extra, getState, rejectWithValue }) => {
  try {
    const { auth } = extra

    // Infer storage mode from state if not provided
    let effectiveMode = storageMode
    if (!effectiveMode) {
      const conversation = getState().conversations.items.find(c => c.id === id)
      effectiveMode = conversation?.storage_mode || (isElectronCommunityMode() ? 'local' : 'cloud')
    }

    if (shouldUseLocalApi(effectiveMode, environment)) {
      await localApi.delete(`/app/conversations/${id}`)
    } else {
      await api.delete(`/conversations/${id}/`, auth.accessToken)
      // Sync deletion to local SQLite
      dualSync.syncConversation({ id }, 'delete')
    }

    return id
  } catch (err) {
    return rejectWithValue(err instanceof Error ? err.message : 'Failed to delete conversation')
  }
})

// Fetch the conversation system prompt and store in state.chat.systemPrompt
export const fetchSystemPrompt = createAsyncThunk<string | null, ConversationId, { extra: ThunkExtraArgument }>(
  'chat/fetchSystemPrompt',
  async (conversationId, { dispatch, extra, rejectWithValue }) => {
    try {
      const { auth } = extra

      if (isElectronCommunityMode()) {
        const conversation = await localApi.get<Conversation>(`/app/conversations/${conversationId}`)
        const value = typeof conversation.system_prompt === 'string' ? conversation.system_prompt : null
        dispatch(systemPromptSet(value))
        return value
      }

      const res = await getConversationSystemPrompt(conversationId, auth.accessToken)
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
  async (conversationId, { dispatch, extra, rejectWithValue }) => {
    try {
      const { auth } = extra

      if (isElectronCommunityMode()) {
        const conversation = await localApi.get<Conversation>(`/app/conversations/${conversationId}`)
        const value = conversation.conversation_context ?? null
        dispatch(convContextSet(value))
        return value
      }

      const res = await getConversationContext(conversationId, auth.accessToken)
      const value = res.context
      // console.log('dispatching convContext ', res)
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
>('chat/updateSystemPrompt', async ({ id, systemPrompt, storageMode }, { dispatch, extra, getState, rejectWithValue }) => {
  try {
    const { auth } = extra

    // Infer storage mode from state if not provided
    let effectiveMode = storageMode
    if (!effectiveMode) {
      const conversation = getState().conversations.items.find(c => c.id === id)
      effectiveMode = conversation?.storage_mode || (isElectronCommunityMode() ? 'local' : 'cloud')
    }

    if (shouldUseLocalApi(effectiveMode, environment)) {
      const updated = await localApi.patch<Conversation>(`/app/conversations/${id}`, { system_prompt: systemPrompt })
      // Mirror to client state
      dispatch(systemPromptSet(updated.system_prompt ?? null))
      return { id: updated.id, system_prompt: updated.system_prompt } as SystemPromptPatchResponse
    }

    const updated = await patchConversationSystemPrompt(id, systemPrompt, auth.accessToken)
    // Server returns updated Conversation with snake_case system_prompt
    // Mirror to client state
    dispatch(systemPromptSet((updated as any).system_prompt ?? null))
    return updated
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update system prompt'
    return rejectWithValue(message) as any
  }
})

export const updateContext = createAsyncThunk<
  { id: ConversationId; context: string | null }, // return type
  { id: ConversationId; context: string | null; storageMode?: 'cloud' | 'local' }, // argument type
  { extra: ThunkExtraArgument; state: RootState }
>('chat/updateContext', async ({ id, context, storageMode }, { dispatch, extra, getState, rejectWithValue }) => {
  try {
    const { auth } = extra

    // Infer storage mode from state if not provided
    let effectiveMode = storageMode
    if (!effectiveMode) {
      const conversation = getState().conversations.items.find(c => c.id === id)
      effectiveMode = conversation?.storage_mode || (isElectronCommunityMode() ? 'local' : 'cloud')
    }

    if (shouldUseLocalApi(effectiveMode, environment)) {
      const updated = await localApi.patch<Conversation>(`/app/conversations/${id}`, { conversation_context: context })
      const next = { id: updated.id, context: updated.conversation_context ?? null }
      dispatch(convContextSet(next.context))
      return next
    }

    const updated = await patchConversationContext(id, context, auth.accessToken) // ConversationPatchResponse
    const next = { id: updated.id, context: updated.conversation_context ?? null }
    dispatch(convContextSet(next.context))
    return next
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update context'
    return rejectWithValue(message) as any
  }
})

export const updateResearchNote = createAsyncThunk<
  Conversation, // return type - full conversation object for cache update
  { id: ConversationId; researchNote: string | null; storageMode?: 'cloud' | 'local' }, // argument type
  { extra: ThunkExtraArgument; state: RootState }
>('conversations/updateResearchNote', async ({ id, researchNote, storageMode }, { extra, getState, rejectWithValue }) => {
  try {
    const { auth } = extra

    // Infer storage mode from state if not provided
    let effectiveMode = storageMode
    if (!effectiveMode) {
      const conversation = getState().conversations.items.find(c => c.id === id)
      effectiveMode = conversation?.storage_mode || (isElectronCommunityMode() ? 'local' : 'cloud')
    }

    if (shouldUseLocalApi(effectiveMode, environment)) {
      const updated = await localApi.patch<Conversation>(`/app/conversations/${id}`, { research_note: researchNote })
      return updated
    }

    const updated = await patchConversationResearchNote(id, researchNote, auth.accessToken)

    // Sync to local SQLite using specific method
    dualSync.syncResearchNote({ id, researchNote })

    return updated as Conversation
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update research note'
    return rejectWithValue(message) as any
  }
})

export const updateCwd = createAsyncThunk<
  Conversation, // return type - full conversation object for cache update
  { id: ConversationId; cwd: string | null; storageMode?: 'cloud' | 'local' }, // argument type
  { extra: ThunkExtraArgument; state: RootState }
>('conversations/updateCwd', async ({ id, cwd, storageMode }, { extra, getState, rejectWithValue }) => {
  try {
    const { auth } = extra

    // Infer storage mode from state if not provided
    let effectiveMode = storageMode
    if (!effectiveMode) {
      const conversation = getState().conversations.items.find(c => c.id === id)
      effectiveMode = conversation?.storage_mode || (isElectronCommunityMode() ? 'local' : 'cloud')
    }

    if (shouldUseLocalApi(effectiveMode, environment)) {
      const updated = await localApi.patch<Conversation>(`/app/conversations/${id}`, { cwd })
      return updated
    }

    const updated = await patchConversationCwd(id, cwd, auth.accessToken)

    // Sync to local SQLite using specific method
    dualSync.syncCwd({ id, cwd })

    return updated as Conversation
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update cwd'
    return rejectWithValue(message) as any
  }
})

// Search conversations by title from the server
// Used as fallback when local cache search returns no results
export const searchConversations = createAsyncThunk<
  Conversation[],
  { query: string; projectId?: ProjectId | null; limit?: number },
  { extra: ThunkExtraArgument }
>('conversations/search', async ({ query, projectId, limit = 20 }, { extra, rejectWithValue }) => {
  try {
    const { auth } = extra

    if (!auth.accessToken) {
      throw new Error('User not authenticated')
    }

    if (isElectronCommunityMode()) {
      const localConversations = await localApi.get<Conversation[]>(`/app/conversations?userId=${auth.userId}`)
      const normalizedQuery = query.trim().toLowerCase()
      const filtered = localConversations.filter(conversation => {
        const inProject = projectId ? String(conversation.project_id) === String(projectId) : true
        const title = (conversation.title || '').toLowerCase()
        return inProject && title.includes(normalizedQuery)
      })

      return filtered
        .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
        .slice(0, limit)
    }

    const params = new URLSearchParams({ q: query, limit: String(limit) })

    // Use project-specific search if projectId is provided
    const endpoint = projectId
      ? `/search/project?${params.toString()}&projectId=${projectId}`
      : `/search?${params.toString()}`

    const results = await api.get<Conversation[]>(endpoint, auth.accessToken)
    return results
  } catch (err) {
    return rejectWithValue(err instanceof Error ? err.message : 'Failed to search conversations')
  }
})
