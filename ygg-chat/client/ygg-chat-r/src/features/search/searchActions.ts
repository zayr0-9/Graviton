import { createAsyncThunk } from '@reduxjs/toolkit'
import { ProjectId } from '../../../../../shared/types'
import { ThunkExtraArgument } from '../../store/thunkExtra'
import { apiCall } from '../../utils/api'
import { SearchResult } from './searchTypes'

// Async thunk to perform search against server API
export const performSearch = createAsyncThunk<
  SearchResult[],
  string,
  { rejectValue: string; extra: ThunkExtraArgument }
>('search/perform', async (query, { extra, rejectWithValue }) => {
  try {
    const { auth } = extra
    const raw: any[] = await apiCall<any[]>(
      `/search?q=${encodeURIComponent(query)}&userId=${auth.userId}`,
      null
    )
    const data: SearchResult[] = raw.map(r => ({
      conversationId: r.conversation_id ?? r.conversationId,
      messageId: r.messageId ?? r.id?.toString(),
      content: r.content,
      createdAt: r.created_at ?? r.createdAt ?? new Date().toISOString(),
      highlighted: r.highlighted,
      conversationTitle: r.conversation_title ?? r.conversationTitle,
    }))
    return data.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return rejectWithValue(message)
  }
})

// Async thunk to perform project-specific search
export const performProjectSearch = createAsyncThunk<
  SearchResult[],
  { query: string; projectId?: ProjectId },
  { rejectValue: string; extra: ThunkExtraArgument }
>('search/performProject', async ({ query, projectId }, { rejectWithValue }) => {
  try {
    const raw: any[] = await apiCall<any[]>(
      `/search/project?q=${encodeURIComponent(query)}&projectId=${projectId}`,
      null
    )
    const data: SearchResult[] = raw.map(r => ({
      conversationId: r.conversation_id ?? r.conversationId,
      messageId: r.messageId ?? r.id?.toString(),
      content: r.content,
      createdAt: r.created_at ?? r.createdAt ?? new Date().toISOString(),
      highlighted: r.highlighted,
      conversationTitle: r.conversation_title ?? r.conversationTitle,
    }))
    return data.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return rejectWithValue(message)
  }
})
