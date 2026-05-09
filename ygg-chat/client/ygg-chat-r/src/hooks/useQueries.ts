// React Query hooks for data fetching with automatic caching and deduplication
import { QueryClient, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLocation } from 'react-router-dom'
import type { BaseModel, Project } from '../../../../shared/types'
import { ConversationId, ProjectId, ProjectWithLatestConversation } from '../../../../shared/types'
import type { LocalFileEntry, LocalFileListingResponse, LocalFileSearchResponse } from '../../shared/localFileBrowser'
import type {
  LocalGitActionResponse,
  LocalGitBranch,
  LocalGitCommit,
  LocalGitDiffResponse,
  LocalGitOverviewResponse,
  LocalGitRepoSummary,
  LocalGitStatusFile,
} from '../../shared/localGit'
import type { Message, Model } from '../features/chats/chatTypes'
import { fetchLmStudioModels } from '../features/chats/LMStudio'
import { getOpenAIChatGPTModels } from '../features/chats/openaiOAuth'
import type { Conversation } from '../features/conversations/conversationTypes'
import { isCommunityMode } from '../config/runtimeMode'
import { api, environment, localApi } from '../utils/api'
import { getFavoritedModels } from '../utils/favorites'
import { useAuth } from './useAuth'

const isElectronCommunityMode = () => environment === 'electron' && isCommunityMode

/**
 * Fetch all projects for the current user, sorted by latest conversation
 * Cache key: ['projects']
 * Returns projects with latest_conversation_updated_at for efficient sorting
 * Eliminates need to fetch all conversations separately
 *
 * Refetch behavior:
 * - Homepage: Always refetch to show latest projects
 * - Chat.tsx: Never refetch (uses persisted cache for instant UI)
 *
 * @returns Query result with data, isLoading, isRefetching, and refetch function for manual refresh
 */
export function useProjects() {
  const { accessToken, userId } = useAuth()
  const location = useLocation()

  // Always refetch on Homepage route (`/homepage`), never on Chat.tsx
  const isHomePage = location.pathname === '/homepage' || location.pathname === '/'

  const query = useQuery({
    queryKey: ['projects', userId],
    queryFn: async () => {
      // In Electron community mode, use local projects only
      if (isElectronCommunityMode()) {
        const localProjects = await localApi.get<ProjectWithLatestConversation[]>(`/app/projects?userId=${userId}`)
        return [...localProjects].sort((a, b) => {
          const dateA = new Date(a.latest_conversation_updated_at || a.updated_at).getTime()
          const dateB = new Date(b.latest_conversation_updated_at || b.updated_at).getTime()
          return dateB - dateA
        })
      }

      // In Electron mode, fetch both cloud and local projects
      if (environment === 'electron') {
        const [cloudProjects, localProjects] = await Promise.all([
          api
            .get<ProjectWithLatestConversation[]>(`/projects/sorted/latest-conversation?userId=${userId}`, accessToken)
            .catch(err => {
              console.error('Failed to fetch cloud projects:', err)
              return []
            }),
          localApi.get<ProjectWithLatestConversation[]>(`/app/projects?userId=${userId}`).catch(err => {
            console.error('Failed to fetch local projects:', err)
            return []
          }),
        ])

        // Merge and sort by latest_conversation_updated_at or updated_at
        const merged = [...cloudProjects, ...localProjects].sort((a, b) => {
          const dateA = new Date(a.latest_conversation_updated_at || a.updated_at).getTime()
          const dateB = new Date(b.latest_conversation_updated_at || b.updated_at).getTime()
          return dateB - dateA
        })

        return merged
      }

      // Web mode: cloud only
      return api.get<ProjectWithLatestConversation[]>(
        `/projects/sorted/latest-conversation?userId=${userId}`,
        accessToken
      )
    },
    enabled: !!accessToken && !!userId,
    staleTime: 10 * 60 * 1000, // Projects don't change often, 10 minute cache
    refetchOnMount: isHomePage ? 'always' : false, // Force fresh data on Homepage
    refetchOnReconnect: false,
    refetchOnWindowFocus: false, // Don't refetch when user switches tabs
  })

  // Expose refetch and isRefetching for manual refresh button
  return {
    ...query,
    refetch: query.refetch,
    isRefetching: query.isRefetching,
  }
}

/**
 * Fetch a single project by ID
 * Cache key: ['projects', projectId]
 */
export function useProject(projectId: ProjectId | null, storageMode?: 'local' | 'cloud') {
  const { accessToken, userId } = useAuth()
  const queryClient = useQueryClient()

  return useQuery({
    queryKey: ['projects', projectId],
    queryFn: async () => {
      if (!projectId) throw new Error('Project ID is required')

      // Determine storage mode: use parameter if provided, otherwise check cached projects
      let effectiveStorageMode = storageMode
      if (!effectiveStorageMode) {
        // Try to get storage_mode from cached projects
        const projects = queryClient.getQueryData<ProjectWithLatestConversation[]>(['projects', userId])
        const project = projects?.find(p => p.id === projectId)
        effectiveStorageMode = project?.storage_mode || 'cloud'
      }

      // console.log('[useProject] Fetching project:', projectId, 'storage_mode:', effectiveStorageMode)

      // Route to appropriate API based on storage mode
      if ((effectiveStorageMode === 'local' && environment === 'electron') || isElectronCommunityMode()) {
        // console.log('[useProject] Using local API for project:', projectId)
        return localApi.get<Project>(`/app/projects/${projectId}`)
      }

      // Default to cloud API
      // console.log('[useProject] Using cloud API for project:', projectId)
      return api.get<Project>(`/projects/${projectId}`, accessToken)
    },
    enabled: !!projectId && !!accessToken,
    staleTime: 10000,
  })
}

/**
 * Fetch all conversations for the current user
 * Cache key: ['conversations']
 *
 * Refetch behavior:
 * - ConversationPage: Always refetch to show latest conversations
 * - Chat.tsx: Never refetch (uses persisted cache for instant UI)
 *
 * @param enabled - Optional flag to control whether the query runs (default: true)
 * @returns Query result with data, isLoading, isRefetching, and refetch function for manual refresh
 */
export function useConversations(enabled: boolean = true) {
  const { accessToken, userId: authUserId } = useAuth()
  // const location = useLocation()

  // Use userId from AuthContext (works for both local mode with UUID and web mode)
  const userId = authUserId

  // Always refetch on ConversationPage, never on Chat.tsx
  // const isConversationPage = location.pathname.includes('/conversationPage')

  const query = useQuery({
    queryKey: ['conversations'],
    queryFn: async () => {
      if (!userId) throw new Error('User not authenticated')

      // In Electron community mode, use local conversations only
      if (isElectronCommunityMode()) {
        const localConversations = await localApi.get<Conversation[]>(`/app/conversations?userId=${userId}`)
        return [...localConversations].sort(
          (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
        )
      }

      // In Electron mode, fetch both cloud and local conversations
      if (environment === 'electron') {
        const [cloudConversations, localConversations] = await Promise.all([
          api.get<Conversation[]>(`/users/${userId}/conversations`, accessToken).catch(err => {
            console.error('Failed to fetch cloud conversations:', err)
            return []
          }),
          localApi.get<Conversation[]>(`/app/conversations?userId=${userId}`).catch(err => {
            console.error('Failed to fetch local conversations:', err)
            return []
          }),
        ])

        // Merge and sort by updated_at
        const merged = [...cloudConversations, ...localConversations].sort(
          (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
        )

        return merged
      }

      return api.get<Conversation[]>(`/users/${userId}/conversations`, accessToken)
    },
    enabled: enabled && !!userId && !!accessToken,
    staleTime: 5 * 60 * 1000, // Conversations list doesn't change often, 5 minute cache
    // refetchOnMount: isConversationPage ? 'always' : false, // Force fresh data on ConversationPage
    refetchOnMount: true,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false, // Don't refetch when user switches tabs
  })

  // Expose refetch and isRefetching for manual refresh button
  return {
    ...query,
    refetch: query.refetch,
    isRefetching: query.isRefetching,
  }
}

/**
 * Paginated response shape from server
 */
export interface PaginatedConversationsResponse {
  conversations: Conversation[]
  nextCursor: string | null
  hasMore: boolean
}

const PAGE_SIZE = 50

/**
 * Fetch conversations with infinite scroll pagination
 * Cache key: ['conversations', 'infinite']
 *
 * Uses cursor-based pagination for stable scrolling experience.
 * New conversations created during session are prepended to first page.
 *
 * @param enabled - Optional flag to control whether the query runs
 * @returns InfiniteQuery result with pages, fetchNextPage, hasNextPage, isFetchingNextPage
 */
export function useConversationsInfinite(enabled: boolean = true) {
  const { accessToken, userId: authUserId } = useAuth()
  const userId = authUserId

  return useInfiniteQuery({
    queryKey: ['conversations', 'infinite'],
    queryFn: async ({ pageParam }) => {
      if (!userId) throw new Error('User not authenticated')

      // Build query string
      const params = new URLSearchParams({ limit: String(PAGE_SIZE) })
      if (pageParam) {
        params.set('cursor', pageParam)
      }

      // In Electron community mode, use local conversations only
      if (isElectronCommunityMode()) {
        const localConversations = await localApi.get<Conversation[]>(`/app/conversations?userId=${userId}`)
        if (!pageParam) {
          const sorted = [...localConversations].sort(
            (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
          )
          return {
            conversations: sorted.slice(0, PAGE_SIZE),
            nextCursor: null,
            hasMore: sorted.length > PAGE_SIZE,
          }
        }
        return {
          conversations: [],
          nextCursor: null,
          hasMore: false,
        }
      }

      // In Electron mode, fetch both cloud and local conversations
      if (environment === 'electron') {
        const [cloudResult, localConversations] = await Promise.all([
          api
            .get<PaginatedConversationsResponse>(
              `/users/${userId}/conversations/paginated?${params.toString()}`,
              accessToken
            )
            .catch(err => {
              console.error('Failed to fetch cloud conversations:', err)
              return { conversations: [], nextCursor: null, hasMore: false }
            }),
          localApi.get<Conversation[]>(`/app/conversations?userId=${userId}`).catch(err => {
            console.error('Failed to fetch local conversations:', err)
            return []
          }),
        ])

        // For first page, merge local conversations
        // Local conversations are only included on first page since they're not paginated
        if (!pageParam) {
          const merged = [...localConversations, ...cloudResult.conversations].sort(
            (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
          )
          return {
            conversations: merged.slice(0, PAGE_SIZE),
            nextCursor: cloudResult.nextCursor,
            hasMore: cloudResult.hasMore || merged.length > PAGE_SIZE,
          }
        }

        return cloudResult
      }

      // Web mode: cloud only
      return api.get<PaginatedConversationsResponse>(
        `/users/${userId}/conversations/paginated?${params.toString()}`,
        accessToken
      )
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: lastPage => (lastPage.hasMore ? lastPage.nextCursor : undefined),
    enabled: enabled && !!userId && !!accessToken,
    staleTime: 5 * 60 * 1000,
    refetchOnMount: true,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
  })
}

/**
 * Fetch conversations for a specific project
 * Cache key: ['conversations', 'project', projectId]
 *
 * Refetch behavior:
 * - Always refetch when the hook mounts so expanding a project in the sidebar fetches
 *   the latest conversations instead of serving stale cached project conversations.
 *
 * @returns Query result with data, isLoading, isRefetching, and refetch function for manual refresh
 */
export function useConversationsByProject(projectId: ProjectId | null, enabled: boolean = true) {
  const { accessToken, userId } = useAuth()
  // const location = useLocation()

  // Always refetch on ConversationPage
  // const isConversationPage = location.pathname.includes('/conversationPage')

  const query = useQuery({
    queryKey: ['conversations', 'project', projectId],
    queryFn: async () => {
      if (!projectId) throw new Error('Project ID is required')

      // In Electron community mode, use local conversations only
      if (isElectronCommunityMode()) {
        const localConversations = await localApi.get<Conversation[]>(
          `/app/conversations?userId=${userId}&projectId=${projectId}`
        )
        return [...localConversations].sort(
          (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
        )
      }

      // In Electron mode, fetch both cloud and local conversations
      if (environment === 'electron') {
        const [cloudConversations, localConversations] = await Promise.all([
          api.get<Conversation[]>(`/conversations/project/${projectId}`, accessToken).catch(err => {
            console.error('Failed to fetch cloud project conversations:', err)
            return []
          }),
          localApi.get<Conversation[]>(`/app/conversations?userId=${userId}&projectId=${projectId}`).catch(err => {
            console.error('Failed to fetch local project conversations:', err)
            return []
          }),
        ])

        // Merge and sort by updated_at
        const merged = [...cloudConversations, ...localConversations].sort(
          (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
        )

        return merged
      }

      return api.get<Conversation[]>(`/conversations/project/${projectId}`, accessToken)
    },
    enabled: enabled && !!projectId && !!accessToken,
    staleTime: 0,
    // Always refetch on mount so sidebar project expansion fetches fresh server data.
    refetchOnMount: 'always',
    refetchOnReconnect: false,
    refetchOnWindowFocus: false, // Don't refetch when user switches tabs
  })

  // Expose refetch and isRefetching for manual refresh button
  return {
    ...query,
    refetch: query.refetch,
    isRefetching: query.isRefetching,
  }
}

/**
 * Fetch project conversations with infinite scroll pagination
 * Cache key: ['conversations', 'project', projectId, 'infinite']
 *
 * @param projectId - Project ID to filter by
 * @returns InfiniteQuery result with pages, fetchNextPage, hasNextPage, isFetchingNextPage
 */
export function useConversationsByProjectInfinite(projectId: ProjectId | null) {
  const { accessToken, userId } = useAuth()

  return useInfiniteQuery({
    queryKey: ['conversations', 'project', projectId, 'infinite'],
    queryFn: async ({ pageParam }) => {
      if (!projectId) throw new Error('Project ID is required')

      const params = new URLSearchParams({ limit: String(PAGE_SIZE) })
      if (pageParam) {
        params.set('cursor', pageParam)
      }

      // Electron community mode with local project conversations
      if (isElectronCommunityMode()) {
        const localConversations = await localApi.get<Conversation[]>(
          `/app/conversations?userId=${userId}&projectId=${projectId}`
        )

        if (!pageParam) {
          const merged = [...localConversations].sort(
            (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
          )
          return {
            conversations: merged.slice(0, PAGE_SIZE),
            nextCursor: null,
            hasMore: merged.length > PAGE_SIZE,
          }
        }

        return {
          conversations: [],
          nextCursor: null,
          hasMore: false,
        }
      }

      // Electron mode with local + cloud project conversations
      if (environment === 'electron') {
        const [cloudResult, localConversations] = await Promise.all([
          api
            .get<PaginatedConversationsResponse>(
              `/conversations/project/${projectId}/paginated?${params.toString()}`,
              accessToken
            )
            .catch(err => {
              console.error('Failed to fetch cloud project conversations:', err)
              return { conversations: [], nextCursor: null, hasMore: false }
            }),
          localApi.get<Conversation[]>(`/app/conversations?userId=${userId}&projectId=${projectId}`).catch(err => {
            console.error('Failed to fetch local project conversations:', err)
            return []
          }),
        ])

        if (!pageParam) {
          const merged = [...localConversations, ...cloudResult.conversations].sort(
            (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
          )
          return {
            conversations: merged.slice(0, PAGE_SIZE),
            nextCursor: cloudResult.nextCursor,
            hasMore: cloudResult.hasMore || merged.length > PAGE_SIZE,
          }
        }

        return cloudResult
      }

      return api.get<PaginatedConversationsResponse>(
        `/conversations/project/${projectId}/paginated?${params.toString()}`,
        accessToken
      )
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: lastPage => (lastPage.hasMore ? lastPage.nextCursor : undefined),
    enabled: !!projectId && !!accessToken,
    staleTime: 5 * 60 * 1000,
    refetchOnMount: true,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
  })
}

/**
 * Fetch recent conversations with a limit
 * Cache key: ['conversations', 'recent', userId, limit]
 */
export function useRecentConversations(limit: number = 120) {
  const { accessToken, userId: authUserId } = useAuth()

  // Use userId from AuthContext (works for both local mode with UUID and web mode)
  const userId = authUserId
  const safeLimit = Math.max(1, Math.floor(Number.isFinite(limit) ? limit : 120))

  return useQuery({
    queryKey: ['conversations', 'recent', userId, safeLimit],
    queryFn: async () => {
      if (!userId) throw new Error('User not authenticated')
      const query = new URLSearchParams({ limit: String(safeLimit) }).toString()

      // In Electron community mode, use local conversations only
      if (isElectronCommunityMode()) {
        const localConversations = await localApi.get<Conversation[]>(`/app/conversations?userId=${userId}`)
        return [...localConversations]
          .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
          .slice(0, safeLimit)
      }

      // In Electron mode, fetch both cloud and local conversations
      if (environment === 'electron') {
        const [cloudConversations, localConversations] = await Promise.all([
          api.get<any[]>(`/users/${userId}/conversations/recent?${query}`, accessToken).catch(err => {
            console.error('Failed to fetch cloud recent conversations:', err)
            return []
          }),
          localApi.get<Conversation[]>(`/app/conversations?userId=${userId}`).catch(err => {
            console.error('Failed to fetch local conversations:', err)
            return []
          }),
        ])

        // Transform cloud response to client format
        const normalizedCloud: Conversation[] = cloudConversations.map((conv: any) => ({
          ...conv,
          id: String(conv.id),
          user_id: conv.owner_id || String(conv.user_id),
          project_id: conv.project_id ? String(conv.project_id) : null,
        }))

        // Merge, sort by updated_at, and take the most recent `limit` conversations
        const merged = [...normalizedCloud, ...localConversations]
          .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
          .slice(0, safeLimit)

        return merged
      }

      // Web mode: cloud only
      const response = await api.get<any[]>(`/users/${userId}/conversations/recent?${query}`, accessToken)

      // Transform server response to client format
      // - Local mode: user_id is number, convert to string
      // - Web mode: owner_id is string UUID, map to user_id
      const normalized: Conversation[] = response.map((conv: any) => ({
        ...conv,
        id: String(conv.id),
        user_id: conv.owner_id || String(conv.user_id),
        project_id: conv.project_id ? String(conv.project_id) : null,
      }))

      return normalized
    },
    enabled: !!userId && !!accessToken,
    staleTime: 5 * 60 * 1000, // Recent conversations list, 5 minute cache
    refetchOnMount: false, // Don't refetch if data exists
    refetchOnReconnect: false,
    refetchOnWindowFocus: false, // Don't refetch when user switches tabs
  })
}

/**
 * Fetch favorited conversations (local-only)
 * Cache key: ['conversations', 'favorites', limit]
 */
export function useFavoritedConversations(limit: number | null = 8) {
  const { userId: authUserId } = useAuth()
  const userId = authUserId
  const hasLimit = typeof limit === 'number' && Number.isFinite(limit)
  const keyLimit = hasLimit ? limit : 'all'

  return useQuery({
    queryKey: ['conversations', 'favorites', keyLimit],
    queryFn: async () => {
      if (!userId) throw new Error('User not authenticated')
      if (environment !== 'electron') return []

      const params = new URLSearchParams({ userId })
      if (hasLimit) {
        params.set('limit', String(limit))
      }
      return localApi.get<Conversation[]>(`/app/conversations/favorites?${params}`)
    },
    enabled: !!userId && environment === 'electron',
    staleTime: 5 * 60 * 1000,
    refetchOnMount: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
  })
}

/**
 * Fetch all data for a conversation (messages, tree, system prompt, context)
 * Cache key: ['conversations', conversationId, 'data']
 */
export function useConversationData(conversationId: ConversationId | null) {
  const { accessToken } = useAuth()

  return useQuery({
    queryKey: ['conversations', conversationId, 'data'],
    queryFn: async () => {
      if (!conversationId) throw new Error('Conversation ID is required')

      // Fetch all data in parallel
      const [messages, treeData, systemPromptRes, contextRes] = await Promise.all([
        api.get<Message[]>(`/conversations/${conversationId}/messages`, accessToken),
        api.get<any>(`/conversations/${conversationId}/messages/tree`, accessToken),
        api.get<{ systemPrompt: string | null }>(`/conversations/${conversationId}/system-prompt`, accessToken),
        api.get<{ context: string | null }>(`/conversations/${conversationId}/context`, accessToken),
      ])

      return {
        messages: messages || [],
        treeData,
        systemPrompt: systemPromptRes?.systemPrompt ?? null,
        context: contextRes?.context ?? null,
      }
    },
    enabled: !!conversationId && !!accessToken,
    staleTime: 2000, // Conversation data changes frequently during chat
  })
}

/**
 * Hook to determine the storage mode for a conversation with high reliability.
 * Checks multiple cache sources and falls back to fetching if necessary.
 *
 * Priority:
 * 1. Check 'conversations' cache (all conversations)
 * 2. Check 'conversations', 'project', projectId cache
 * 3. Check 'conversations', 'recent' cache
 * 4. Fetch from local server (if Electron) - authoritative source for local
 * 5. Default to 'cloud'
 */
export function useConversationStorageMode(conversationId: ConversationId | null) {
  const queryClient = useQueryClient()

  return useQuery({
    queryKey: ['conversations', conversationId, 'storage_mode'],
    queryFn: async () => {
      if (!conversationId) return isElectronCommunityMode() ? 'local' : 'cloud'

      if (isElectronCommunityMode()) {
        return 'local' as const
      }

      // 1. Check all cached conversation lists
      const allConversationQueries = queryClient.getQueriesData<Conversation[]>({ queryKey: ['conversations'] })
      for (const [_, data] of allConversationQueries) {
        if (Array.isArray(data)) {
          const match = data.find(c => String(c.id) === String(conversationId))
          if (match?.storage_mode) {
            return match.storage_mode
          }
        }
      }

      // 2. If in Electron, try fetching from local server first (fastest for local)
      if (environment === 'electron') {
        try {
          const localConv = await localApi.get<Conversation>(`/app/conversations/${conversationId}`)
          if (localConv) {
            return localConv.storage_mode || 'local'
          }
        } catch (err) {
          // Not found locally, proceed to cloud check
        }
      }

      // 3. Default to cloud (or could fetch from cloud to be sure, but 'cloud' is safe default)
      return 'cloud' as const
    },
    enabled: !!conversationId,
    staleTime: Infinity, // Storage mode never changes for a conversation ID
    gcTime: 30 * 60 * 1000, // Keep in cache for 30 minutes
  })
}

export interface TopLevelUserMessagePreview {
  id: string
  conversation_id: string
  content: string
  plain_text_content: string | null
  note: string | null
  note_color?: string | null
  created_at: string
}

/**
 * Fetch top-level user messages for a conversation from local SQLite API.
 * Used for sidebar hover preview in expanded sidebar modal.
 * Cache key: ['conversations', conversationId, 'top-level-user-messages']
 */
export function useLocalTopLevelUserMessages(conversationId: ConversationId | null, enabled: boolean = true) {
  return useQuery({
    queryKey: ['conversations', conversationId, 'top-level-user-messages'],
    queryFn: async () => {
      if (!conversationId) throw new Error('Conversation ID is required')
      return localApi.get<TopLevelUserMessagePreview[]>(`/app/conversations/${conversationId}/messages/top-level-users`)
    },
    enabled: enabled && !!conversationId && environment === 'electron',
    staleTime: 60 * 1000,
    refetchOnMount: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
  })
}

/**
 * Fetch messages and tree data for a conversation in a single request
 * Cache key: ['conversations', conversationId, 'messages']
 *
 * IMPORTANT: This hook provides automatic request deduplication.
 * Multiple components calling this with the same conversationId will share
 * a single network request and cached result.
 *
 * Returns: { messages: Message[], tree: ChatNode }
 */
/**
 * Recursively filter out ex_agent nodes from the message tree, promoting their children
 */
function filterExAgentNodes(node: any): any | null {
  if (!node) return null

  // If this is an ex_agent node, return its filtered children (promote them)
  if (node.sender === 'ex_agent') {
    if (node.children && node.children.length > 0) {
      const filteredChildren = node.children.map(filterExAgentNodes).filter(Boolean)
      // Return children directly (they'll be merged by parent)
      return filteredChildren.length === 1
        ? filteredChildren[0]
        : { ...node, children: filteredChildren, _promoted: true }
    }
    return null
  }

  // Filter children recursively, flattening promoted nodes
  if (node.children && node.children.length > 0) {
    const newChildren: any[] = []
    for (const child of node.children) {
      const filtered = filterExAgentNodes(child)
      if (filtered) {
        if (filtered._promoted && Array.isArray(filtered.children)) {
          // Flatten promoted children
          newChildren.push(...filtered.children)
        } else {
          newChildren.push(filtered)
        }
      }
    }
    return { ...node, children: newChildren }
  }

  return node
}

const isPersistentGlobalAgentType = (value: string | null | undefined): boolean =>
  value === 'persistent_agent' || value === 'persistent_agent_summary'

const shouldFilterExAgentNodes = (messages: Message[] | undefined): boolean => {
  if (!Array.isArray(messages) || messages.length === 0) return true
  return !messages.some(message => message.role === 'ex_agent' && isPersistentGlobalAgentType(message.ex_agent_type))
}

export function useConversationMessages(conversationId: ConversationId | null, storageMode?: 'local' | 'cloud') {
  const { accessToken } = useAuth()
  const queryClient = useQueryClient()

  const query = useQuery({
    queryKey: ['conversations', conversationId, 'messages'],
    queryFn: async () => {
      if (!conversationId) throw new Error('Conversation ID is required')

      if (isElectronCommunityMode()) {
        const result = await localApi.get<{
          messages: Message[]
          tree: any
          meta?: { storage_mode: 'local' | 'cloud' }
        }>(`/app/conversations/${conversationId}/messages/tree`)
        const tree = shouldFilterExAgentNodes(result.messages) ? filterExAgentNodes(result.tree) : result.tree
        return { ...result, tree }
      }

      // Determine storage mode: use parameter if provided, otherwise check cached conversations
      let effectiveStorageMode = storageMode
      if (!effectiveStorageMode) {
        // Search ALL cached conversation lists (main list, project lists, recent lists)
        // This finds the conversation even if it's only loaded in a specific project view
        const allConversationQueries = queryClient.getQueriesData<Conversation[]>({ queryKey: ['conversations'] })

        for (const [_, data] of allConversationQueries) {
          if (Array.isArray(data)) {
            // Robust comparison handling both string/number IDs
            const match = data.find(c => String(c.id) === String(conversationId))
            if (match) {
              if (match.storage_mode) {
                effectiveStorageMode = match.storage_mode
                // console.log('[useConversationMessages] Found storage_mode in cache:', effectiveStorageMode, 'from query:', queryKey)
                break
              }

              // Fallback: Try to get storage_mode from project if conversation lacks it
              if (match.project_id && accessToken) {
                // Need to find project in cache - usually ['projects', userId]
                // Note: userId is inside useAuth closure
                const projectsQuery = queryClient.getQueriesData<ProjectWithLatestConversation[]>({
                  queryKey: ['projects'],
                })
                for (const [_, projects] of projectsQuery) {
                  if (Array.isArray(projects)) {
                    const project = projects.find(p => p.id === match.project_id)
                    if (project?.storage_mode) {
                      effectiveStorageMode = project.storage_mode
                      // console.log('[useConversationMessages] Found storage_mode via project cache:', effectiveStorageMode)
                      break
                    }
                  }
                }
                if (effectiveStorageMode) break
              }
            }
          }
        }

        // In Electron mode with unknown storage mode, try local first (handles page reload scenario)
        if (!effectiveStorageMode && environment === 'electron') {
          try {
            const localResult = await localApi.get<{
              messages: Message[]
              tree: any
              meta?: { storage_mode: 'local' | 'cloud' }
            }>(`/app/conversations/${conversationId}/messages/tree`)
            // If local API succeeds, return it with ex_agent nodes filtered from tree
            if (localResult) {
              const tree = shouldFilterExAgentNodes(localResult.messages)
                ? filterExAgentNodes(localResult.tree)
                : localResult.tree
              return { ...localResult, tree }
            }
          } catch (err) {
            // Local not found, fall through to cloud
          }
          effectiveStorageMode = 'cloud'
        }

        if (!effectiveStorageMode) effectiveStorageMode = 'cloud'
      }

      // Route to appropriate API based on storage mode
      if (effectiveStorageMode === 'local' && environment === 'electron') {
        const result = await localApi.get<{
          messages: Message[]
          tree: any
          meta?: { storage_mode: 'local' | 'cloud' }
        }>(`/app/conversations/${conversationId}/messages/tree`)
        const tree = shouldFilterExAgentNodes(result.messages) ? filterExAgentNodes(result.tree) : result.tree
        return { ...result, tree }
      }

      // Default to cloud API
      const result = await api.get<{ messages: Message[]; tree: any; meta?: { storage_mode: 'local' | 'cloud' } }>(
        `/conversations/${conversationId}/messages/tree`,
        accessToken
      )
      const tree = shouldFilterExAgentNodes(result.messages) ? filterExAgentNodes(result.tree) : result.tree
      return { ...result, tree }
    },
    enabled: !!conversationId && !!accessToken,
    staleTime: 30000, // 30 seconds - messages only change on user actions (send/edit/branch)
    // Aggressive deduplication: only refetch if data is truly stale
    refetchOnMount: false, // Don't refetch on component mount if data exists
    refetchOnReconnect: false, // Don't refetch on network reconnect
    refetchOnWindowFocus: false, // Don't refetch when user switches tabs
  })

  // Sync storage_mode to cache when data is fetched
  useEffect(() => {
    if (query.data?.meta?.storage_mode && conversationId) {
      // console.log('[useConversationMessages] Updating storage_mode in cache:', query.data.meta.storage_mode)

      // Update the conversation in the list cache
      queryClient.setQueryData<Conversation[]>(['conversations'], old => {
        if (!old) return old
        return old.map(c => (c.id === conversationId ? { ...c, storage_mode: query.data.meta.storage_mode! } : c))
      })
    }
  }, [query.data, conversationId, queryClient])

  return query
}

/**
 * Helper function to convert model name string to Model object
 */
const stringToModel = (modelName: string): Model => ({
  id: modelName,
  name: modelName,
  version: '1.0.0',
  displayName: modelName,
  description: `${modelName} model`,
  contextLength: 4096,
  maxCompletionTokens: 2048,
  inputTokenLimit: 4096,
  outputTokenLimit: 2048,
  promptCost: 0,
  completionCost: 0,
  requestCost: 0,
  thinking: false,
  supportsImages: false,
  supportsWebSearch: false,
  supportsStructuredOutputs: false,
  inputModalities: ['text'],
  outputModalities: ['text'],
  defaultTemperature: null,
  defaultTopP: null,
  defaultFrequencyPenalty: null,
  topProviderContextLength: null,
})

/**
 * Helper function to read selected model from localStorage
 * Returns null if not found or invalid
 */
const getStoredSelectedModel = (): Model | null => {
  try {
    const raw = localStorage.getItem('selectedModel')
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && typeof parsed.name === 'string') {
      return parsed as Model
    }
    return null
  } catch {
    return null
  }
}

/**
 * Fetch models for a specific provider
 * Cache key: ['models', provider]
 *
 * Supports multiple providers: ollama, gemini, anthropic, openai, openrouter, lmstudio
 * Automatically deduplicates requests and caches results
 *
 * Returns: { models: Model[], default: Model, selected: Model }
 * The selected field contains the currently selected model (persisted from localStorage or defaults to server default)
 */
export function useModels(provider: string | null) {
  const { accessToken } = useAuth()

  return useQuery({
    queryKey: ['models', provider],
    queryFn: async () => {
      // console.log(
      //   '[useModels] queryFn EXECUTING for provider:',
      //   provider,
      //   '- This indicates a refetch/fetch is happening'
      // )
      if (!provider) throw new Error('Provider is required')

      const normalizedProvider = provider.toLowerCase()
      const normalizedSlug = normalizedProvider.replace(/\s+/g, '')

      if (normalizedSlug === 'lmstudio') {
        const models = await fetchLmStudioModels()
        const defaultModel = models[0] || stringToModel('lmstudio')

        const storedSelection = getStoredSelectedModel()
        const selectedModel = storedSelection
          ? models.find(m => m.name === storedSelection.name) || defaultModel
          : defaultModel

        return {
          models,
          default: defaultModel,
          selected: selectedModel,
          userIsFreeTier: false,
        }
      }

      // OpenAI ChatGPT - local models (uses user's ChatGPT Plus/Pro subscription)
      if (normalizedSlug === 'openai(chatgpt)' || normalizedSlug === 'openaichatgpt') {
        const models = getOpenAIChatGPTModels() as Model[]
        const defaultModel = models[0] || stringToModel('gpt-5.5')

        const storedSelection = getStoredSelectedModel()
        const selectedModel = storedSelection
          ? models.find(m => m.name === storedSelection.name) || defaultModel
          : defaultModel

        return {
          models,
          default: defaultModel,
          selected: selectedModel,
          userIsFreeTier: false,
        }
      }

      if (isElectronCommunityMode()) {
        throw new Error(`Provider "${provider}" is not available in community mode.`)
      }

      let endpoint = '/models' // Default to Ollama

      // Map provider to appropriate endpoint
      switch (normalizedProvider) {
        case 'google':
        case 'gemini':
          endpoint = '/models/gemini'
          break
        case 'anthropic':
          endpoint = '/models/anthropic'
          break
        case 'openai':
          endpoint = '/models/openai'
          break
        case 'openrouter':
          endpoint = '/models/openrouter'
          break
        default:
          endpoint = '/models' // Ollama
      }

      const response = await api.get<{ models: string[] | Model[]; default: string | Model; userIsFreeTier?: boolean }>(
        endpoint,
        accessToken
      )

      // Handle both string[] and Model[] responses
      const isStringArray = Array.isArray(response.models) && typeof response.models[0] === 'string'

      const models = isStringArray ? (response.models as string[]).map(stringToModel) : (response.models as Model[])
      let defaultModel =
        typeof response.default === 'string' ? stringToModel(response.default as string) : (response.default as Model)

      // For OpenRouter, prefer openai/gpt-5-mini if it exists
      if (normalizedProvider === 'openrouter') {
        const gpt5Mini = models.find(m => m.name === 'openai/gpt-5-mini')
        if (gpt5Mini) {
          defaultModel = gpt5Mini
        }
      }

      // Determine selected model: use localStorage if valid, otherwise use server default
      const storedSelection = getStoredSelectedModel()
      let selectedModel = defaultModel

      // If stored selection exists and matches a model in the list, use the full model data from the list
      if (storedSelection) {
        const matchedModel = models.find(m => m.name === storedSelection.name)
        if (matchedModel) {
          selectedModel = matchedModel
        }
      }

      return {
        models,
        default: defaultModel,
        selected: selectedModel, // Always populated - either from localStorage (if valid) or from server default
        userIsFreeTier: response.userIsFreeTier ?? false, // User's tier status for disabling non-free models
      }
    },
    enabled: !!provider && !!accessToken,
    staleTime: 5 * 60 * 1000, // 5 minutes - models don't change frequently
    refetchOnMount: false, // Don't refetch on component mount if cache exists
    refetchOnReconnect: false,
    refetchOnWindowFocus: false, // Don't refetch when user switches tabs
  })
}

/**
 * Fetch recently used models based on message history
 * Cache key: ['models', 'recent']
 *
 * Returns: BaseModel[] (model names with metadata)
 */
export function useRecentModels(limit: number = 5) {
  const { accessToken } = useAuth()

  return useQuery({
    queryKey: ['models', 'recent'],
    queryFn: async () => {
      if (isElectronCommunityMode()) {
        return []
      }

      const query = new URLSearchParams({ limit: String(limit) }).toString()
      const response = await api.get<{ models: string[] }>(`/models/recent?${query}`, accessToken)
      const models = Array.isArray(response?.models) ? response.models : []

      // Map plain names to BaseModel shape with sensible defaults
      const normalized: BaseModel[] = models.map(name => ({
        id: name,
        name,
        version: '',
        displayName: name,
        description: '',
        contextLength: 0,
        maxCompletionTokens: 0,
        inputTokenLimit: 0,
        outputTokenLimit: 0,
        promptCost: 0,
        completionCost: 0,
        requestCost: 0,
        thinking: false,
        supportsImages: false,
        supportsWebSearch: false,
        supportsStructuredOutputs: false,
        inputModalities: ['text'],
        outputModalities: ['text'],
        defaultTemperature: null,
        defaultTopP: null,
        defaultFrequencyPenalty: null,
        topProviderContextLength: null,
      }))

      return normalized
    },
    enabled: !!accessToken && !isElectronCommunityMode(),
    staleTime: 2 * 60 * 1000, // 2 minutes - recent models are more dynamic
    refetchOnMount: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
  })
}

/**
 * ZDR (Zero Data Retention) endpoint model shape from OpenRouter
 */
export interface ZdrModel {
  id: string
  displayName: string
  providerName: string
  contextLength: number
  supportsImplicitCaching: boolean
  pricing: Record<string, unknown>
  supportedParameters: string[]
  raw: Record<string, unknown>
}

/**
 * Fetch ZDR-capable models from OpenRouter
 * Cache key: ['models', 'openrouter', 'zdr']
 *
 * These are Zero Data Retention endpoints for privacy-focused usage
 * Returns: { endpoints: ZdrModel[] }
 */
export function useZdrModels() {
  const { accessToken } = useAuth()

  return useQuery({
    queryKey: ['models', 'openrouter', 'zdr'],
    queryFn: async () => {
      const response = await api.get<{ endpoints: ZdrModel[] }>('/models/openrouter/zdr', accessToken)
      return response.endpoints || []
    },
    enabled: !!accessToken && !isElectronCommunityMode(),
    staleTime: 5 * 60 * 1000, // 5 minutes - ZDR endpoints don't change frequently
    refetchOnMount: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
  })
}

/**
 * Mutation hook for toggling "Secret Mode" (ZDR models)
 * When enabled, replaces the OpenRouter models cache with ZDR models
 * When disabled, restores normal OpenRouter models
 *
 * Usage:
 * const toggleSecretMode = useToggleSecretMode()
 * toggleSecretMode.mutate({ enabled: true }) // Switch to ZDR models
 * toggleSecretMode.mutate({ enabled: false }) // Switch back to normal models
 */
export function useToggleSecretMode() {
  const queryClient = useQueryClient()
  const { accessToken } = useAuth()

  return useMutation({
    mutationFn: async ({ enabled }: { enabled: boolean }) => {
      if (enabled) {
        // Fetch ZDR models
        const response = await api.get<{ endpoints: ZdrModel[] }>('/models/openrouter/zdr', accessToken)
        const zdrEndpoints = response.endpoints || []

        // Deduplicate endpoints by model id (same model can have multiple ZDR providers)
        // Keep the first occurrence (usually the primary provider)
        const seenIds = new Set<string>()
        const uniqueEndpoints = zdrEndpoints.filter(endpoint => {
          if (seenIds.has(endpoint.id)) {
            return false
          }
          seenIds.add(endpoint.id)
          return true
        })

        // Convert ZDR endpoints to Model format for compatibility
        const models: Model[] = uniqueEndpoints.map(endpoint => ({
          id: endpoint.id,
          name: endpoint.id,
          version: '',
          displayName: endpoint.displayName,
          description: `${endpoint.providerName} - ZDR`,
          contextLength: endpoint.contextLength,
          maxCompletionTokens: 0,
          inputTokenLimit: endpoint.contextLength,
          outputTokenLimit: 0,
          promptCost: 0,
          completionCost: 0,
          requestCost: 0,
          thinking: false,
          supportsImages: false,
          supportsWebSearch: false,
          supportsStructuredOutputs: false,
          inputModalities: ['text'],
          outputModalities: ['text'],
          defaultTemperature: null,
          defaultTopP: null,
          defaultFrequencyPenalty: null,
          topProviderContextLength: endpoint.contextLength,
          isZdr: true, // Mark as ZDR model
        }))

        return { models, enabled: true }
      } else {
        // Fetch normal OpenRouter models
        const response = await api.get<{ models: Model[]; default: Model; userIsFreeTier?: boolean }>(
          '/models/openrouter',
          accessToken
        )
        return { models: response.models, default: response.default, enabled: false }
      }
    },
    onSuccess: (data, { enabled }) => {
      const provider = 'OpenRouter'

      if (enabled) {
        // Replace OpenRouter models cache with ZDR models
        queryClient.setQueryData(['models', provider], (oldData: any) => {
          if (!oldData) return oldData
          const defaultModel = data.models[0] || oldData.default
          return {
            ...oldData,
            models: data.models,
            default: defaultModel,
            selected: defaultModel,
            isSecretMode: true,
          }
        })
      } else {
        // Restore normal OpenRouter models
        const storedSelection = getStoredSelectedModel()
        const defaultModel = (data as any).default || data.models[0]
        let selectedModel = defaultModel

        if (storedSelection) {
          const matchedModel = data.models.find(m => m.name === storedSelection.name)
          if (matchedModel) {
            selectedModel = matchedModel
          }
        }

        queryClient.setQueryData(['models', provider], {
          models: data.models,
          default: defaultModel,
          selected: selectedModel,
          isSecretMode: false,
        })
      }
    },
  })
}

/**
 * Research note item returned from API
 */
export interface ResearchNoteItem {
  id: string
  title: string
  research_note: string
  updated_at: string
  project_id: string | null
}

/**
 * Fetch all research notes for the current user
 * Cache key: ['research-notes', userId]
 *
 * Returns: Array of research notes with conversation metadata
 * Only returns conversations with non-empty research notes
 *
 * @returns Query result with data, isLoading, isRefetching, and refetch function
 */
export function useResearchNotes() {
  const { accessToken, userId } = useAuth()

  return useQuery({
    queryKey: ['research-notes', userId],
    queryFn: async () => {
      if (!userId) throw new Error('User not authenticated')
      return api.get<ResearchNoteItem[]>(`/users/${userId}/research-notes`, accessToken)
    },
    enabled: !!userId && !!accessToken,
    staleTime: 5 * 60 * 1000, // 5 minutes - research notes don't change often
    refetchOnMount: false, // Don't refetch if data exists
    refetchOnReconnect: false,
    refetchOnWindowFocus: false, // Don't refetch when user switches tabs
  })
}

/**
 * Mutation hook for refreshing models (force refetch)
 * Invalidates the models cache for the current provider
 */
export function useRefreshModels() {
  const queryClient = useQueryClient()
  const { accessToken } = useAuth()

  return useMutation({
    mutationFn: async (provider: string) => {
      const normalizedProvider = provider.toLowerCase()
      const normalizedSlug = normalizedProvider.replace(/\s+/g, '')
      let endpoint = '/models'

      if (normalizedSlug === 'lmstudio') {
        const models = await fetchLmStudioModels()
        const defaultModel = models[0] || stringToModel('lmstudio')
        return { models, default: defaultModel }
      }

      switch (normalizedProvider) {
        case 'google':
        case 'gemini':
          endpoint = '/models/gemini'
          break
        case 'anthropic':
          endpoint = '/models/anthropic'
          break
        case 'openai':
          endpoint = '/models/openai'
          break
        case 'openrouter':
          endpoint = '/models/openrouter'
          break
        case 'lmstudio':
          endpoint = '/models/lmstudio'
          break
      }

      const response = await api.get<{ models: string[] | Model[]; default: string | Model }>(endpoint, accessToken)
      const isStringArray = Array.isArray(response.models) && typeof response.models[0] === 'string'

      return {
        models: isStringArray ? (response.models as string[]).map(stringToModel) : (response.models as Model[]),
        default:
          typeof response.default === 'string'
            ? stringToModel(response.default as string)
            : (response.default as Model),
      }
    },
    onSuccess: (data, provider) => {
      // Update the cache with fresh data
      queryClient.setQueryData(['models', provider], data)
    },
  })
}

/**
 * Mutation hook for moving a conversation to a different project
 * Updates React Query caches for both source and destination project conversations
 *
 * Usage:
 * const moveConversationMutation = useMoveConversationToProject()
 * moveConversationMutation.mutate({ conversationId, sourceProjectId, destinationProjectId })
 */
export function useMoveConversationToProject() {
  const queryClient = useQueryClient()
  const { accessToken } = useAuth()

  return useMutation({
    mutationFn: async ({
      conversationId,
      sourceProjectId: _sourceProjectId,
      destinationProjectId,
    }: {
      conversationId: ConversationId
      sourceProjectId: ProjectId | null
      destinationProjectId: ProjectId | null
    }) => {
      // Determine storage mode from cached conversation data
      let storageMode: 'local' | 'cloud' = 'cloud'

      // Search all cached conversation lists to find the storage mode
      const allConversationQueries = queryClient.getQueriesData<Conversation[]>({ queryKey: ['conversations'] })
      for (const [_, data] of allConversationQueries) {
        if (Array.isArray(data)) {
          const match = data.find(c => String(c.id) === String(conversationId))
          if (match?.storage_mode) {
            storageMode = match.storage_mode
            break
          }
        }
      }

      // Route to appropriate API based on storage mode
      if (storageMode === 'local' && environment === 'electron') {
        // Use local API for local conversations
        return localApi.patch<any>(`/conversations/${conversationId}/project`, { projectId: destinationProjectId })
      }

      // Use cloud API for cloud conversations
      const { patchConversationProject } = await import('../utils/api')
      return patchConversationProject(conversationId, destinationProjectId, accessToken)
    },
    onSuccess: (_updatedConversation, { conversationId, sourceProjectId, destinationProjectId }) => {
      // Helper to update conversation in infinite pages
      const updateInPages = (pages: PaginatedConversationsResponse[]) =>
        pages.map(page => ({
          ...page,
          conversations: page.conversations.map(c =>
            c.id === conversationId ? { ...c, project_id: destinationProjectId } : c
          ),
        }))

      const removeFromPages = (pages: PaginatedConversationsResponse[]) =>
        pages.map(page => ({
          ...page,
          conversations: page.conversations.filter(c => c.id !== conversationId),
        }))

      // Update infinite query cache - update project_id in place
      queryClient.setQueryData(
        ['conversations', 'infinite'],
        (old: { pages: PaginatedConversationsResponse[]; pageParams: unknown[] } | undefined) => {
          if (!old) return old
          return { ...old, pages: updateInPages(old.pages) }
        }
      )

      // Remove from source project infinite cache
      if (sourceProjectId) {
        queryClient.setQueryData(
          ['conversations', 'project', sourceProjectId, 'infinite'],
          (old: { pages: PaginatedConversationsResponse[]; pageParams: unknown[] } | undefined) => {
            if (!old) return old
            return { ...old, pages: removeFromPages(old.pages) }
          }
        )
      }

      // Add to destination project infinite cache
      if (destinationProjectId) {
        // Get full conversation from infinite cache
        const allData = queryClient.getQueryData<{ pages: PaginatedConversationsResponse[]; pageParams: unknown[] }>([
          'conversations',
          'infinite',
        ])
        const fullConversation = allData?.pages.flatMap(p => p.conversations).find(c => c.id === conversationId)

        if (fullConversation) {
          const updatedConv = { ...fullConversation, project_id: destinationProjectId }
          queryClient.setQueryData(
            ['conversations', 'project', destinationProjectId, 'infinite'],
            (old: { pages: PaginatedConversationsResponse[]; pageParams: unknown[] } | undefined) => {
              if (!old || old.pages.length === 0) {
                return {
                  pages: [{ conversations: [updatedConv], nextCursor: null, hasMore: false }],
                  pageParams: [undefined],
                }
              }
              return {
                ...old,
                pages: [
                  {
                    ...old.pages[0],
                    conversations: [updatedConv, ...old.pages[0].conversations.filter(c => c.id !== conversationId)],
                  },
                  ...old.pages.slice(1),
                ],
              }
            }
          )
        }
      }

      // Keep flat array caches updated for backward compatibility
      queryClient.setQueryData<Conversation[]>(['conversations'], old => {
        if (!old) return old
        return old.map(c => (c.id === conversationId ? { ...c, project_id: destinationProjectId } : c))
      })

      if (sourceProjectId) {
        queryClient.setQueryData<Conversation[]>(['conversations', 'project', sourceProjectId], old => {
          if (!old) return old
          return old.filter(c => c.id !== conversationId)
        })
      }

      if (destinationProjectId) {
        const allConversations = queryClient.getQueryData<Conversation[]>(['conversations'])
        const fullConversation = allConversations?.find(c => c.id === conversationId)

        queryClient.setQueryData<Conversation[]>(['conversations', 'project', destinationProjectId], old => {
          if (!fullConversation) return old
          const updatedFullConversation = { ...fullConversation, project_id: destinationProjectId }
          if (!old) return [updatedFullConversation]
          const filtered = old.filter(c => c.id !== conversationId)
          return [updatedFullConversation, ...filtered]
        })
      }

      queryClient.setQueryData<Conversation[]>(['conversations', 'recent'], old => {
        if (!old) return old
        return old.map(c => (c.id === conversationId ? { ...c, project_id: destinationProjectId } : c))
      })
    },
  })
}

/**
 * Mutation hook for selecting a model for the current provider
 * Updates both React Query cache and localStorage
 *
 * Usage:
 * const selectModelMutation = useSelectModel()
 * selectModelMutation.mutate({ provider: 'openrouter', model: selectedModel })
 */
export function useSelectModel() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ provider, model }: { provider: string; model: Model }) => {
      // Persist to localStorage
      localStorage.setItem('selectedModel', JSON.stringify(model))
      return { provider, model }
    },
    onSuccess: ({ provider, model }) => {
      // Update the React Query cache with selected model

      queryClient.setQueryData(['models', provider], (oldData: any) => {
        if (!oldData) {
          return oldData
        }
        return {
          ...oldData,
          selected: model,
        }
      })

      // Verify the update
    },
  })
}

/**
 * Hook to get the currently selected model for a provider
 * Returns the selected model from the cache, or null if loading
 *
 * Usage:
 * const selectedModel = useSelectedModel(currentProvider)
 */
export function useSelectedModel(provider: string | null) {
  const { data } = useModels(provider)
  return data?.selected || null
}

/**
 * Hook to get the effective model (always returns a model, never null)
 * Returns selected model if available, otherwise default model
 *
 * Usage:
 * const effectiveModel = useEffectiveModel(currentProvider)
 */
export function useEffectiveModel(provider: string | null) {
  const { data } = useModels(provider)
  return data?.selected || data?.default || null
}

/**
 * Hook to manage a local mutable copy of models with filtering capabilities
 * Creates a working copy that can be filtered by various criteria without affecting the cache
 *
 * Supports filtering by:
 * - generationMethods (e.g., 'streaming', 'completion')
 * - promptCost (min/max range)
 * - completionCost (min/max range)
 * - thinking (boolean - models with reasoning capability)
 * - supportsImages (boolean)
 * - supportsWebSearch (boolean)
 *
 * Usage:
 * const { filteredModels, applyFilters, clearFilters } = useFilteredModels(provider)
 * applyFilters({ thinking: true, supportsImages: true })
 */
export interface ModelFilters {
  thinking?: boolean
  supportsImages?: boolean
  supportsWebSearch?: boolean
  supportsStructuredOutputs?: boolean
  promptCostMin?: number
  promptCostMax?: number
  completionCostMin?: number
  completionCostMax?: number
  contextLengthMax?: number
}

export interface ModelSortOptions {
  sortBy?: 'promptCost' | 'completionCost'
  sortOrder?: 'low-to-high' | 'high-to-low'
}

export function useFilteredModels(provider: string | null) {
  const { data: modelsData } = useModels(provider)
  const [filters, setFilters] = useState<ModelFilters>({})
  const [sortOptions, setSortOptions] = useState<ModelSortOptions>({})
  const [favoritedModels, setFavoritedModels] = useState<string[]>(() => getFavoritedModels())

  // Sync favorites from localStorage on window focus (handles cross-tab updates)
  useEffect(() => {
    const syncFavorites = () => {
      setFavoritedModels(getFavoritedModels())
    }

    window.addEventListener('focus', syncFavorites)
    return () => {
      window.removeEventListener('focus', syncFavorites)
    }
  }, [])

  // Use models directly from cache - no local copy needed
  // This ensures we always have the latest data when cache updates (e.g., ZDR toggle)
  const rawModels = modelsData?.models
  const sourceModels = useMemo(() => {
    if (!rawModels) return [] // Avoid ?? [] which creates new ref
    const seen = new Set<string>()
    return rawModels.filter(m => {
      if (seen.has(m.name)) return false
      seen.add(m.name)
      return true
    })
  }, [rawModels]) // Only depends on the actual array, not a fallback

  // Apply filters and sorting directly to source models
  const filteredModels = useMemo(() => {
    let result = sourceModels.filter(model => {
      // Filter by thinking capability
      if (filters.thinking !== undefined && model.thinking !== filters.thinking) {
        return false
      }

      // Filter by image support
      if (filters.supportsImages !== undefined && model.supportsImages !== filters.supportsImages) {
        return false
      }

      // Filter by web search support
      if (filters.supportsWebSearch !== undefined && model.supportsWebSearch !== filters.supportsWebSearch) {
        return false
      }

      // Filter by structured outputs support
      if (
        filters.supportsStructuredOutputs !== undefined &&
        model.supportsStructuredOutputs !== filters.supportsStructuredOutputs
      ) {
        return false
      }

      // Filter by prompt cost range
      if (filters.promptCostMin !== undefined && model.promptCost < filters.promptCostMin) {
        return false
      }
      if (filters.promptCostMax !== undefined && model.promptCost > filters.promptCostMax) {
        return false
      }

      // Filter by completion cost range
      if (filters.completionCostMin !== undefined && model.completionCost < filters.completionCostMin) {
        return false
      }
      if (filters.completionCostMax !== undefined && model.completionCost > filters.completionCostMax) {
        return false
      }

      // Filter by minimum context length requirement
      if (filters.contextLengthMax !== undefined && model.contextLength < filters.contextLengthMax) {
        return false
      }

      return true
    })

    // Apply sorting if specified
    if (sortOptions.sortBy) {
      const ascending = sortOptions.sortOrder === 'low-to-high'
      result = [...result].sort((a, b) => {
        const aVal = a[sortOptions.sortBy as keyof BaseModel]
        const bVal = b[sortOptions.sortBy as keyof BaseModel]

        if (typeof aVal === 'number' && typeof bVal === 'number') {
          return ascending ? aVal - bVal : bVal - aVal
        }

        return 0
      })
    }

    // Three-tier sorting: 1. Selected model, 2. Favorited models, 3. All others
    // This maintains the relative sorting from filters/sort options within each group
    if (modelsData?.selected) {
      const selectedName = modelsData.selected.name

      result.sort((a, b) => {
        const aIsSelected = a.name === selectedName
        const bIsSelected = b.name === selectedName
        const aIsFavorite = favoritedModels.includes(a.name)
        const bIsFavorite = favoritedModels.includes(b.name)

        // Selected model always comes first
        if (aIsSelected && !bIsSelected) return -1
        if (!aIsSelected && bIsSelected) return 1

        // Among non-selected models, favorites come before non-favorites
        if (!aIsSelected && !bIsSelected) {
          if (aIsFavorite && !bIsFavorite) return -1
          if (!aIsFavorite && bIsFavorite) return 1
        }

        // Maintain original order (from filters/sort) for models in the same tier
        return 0
      })
    }

    return result
  }, [sourceModels, filters, sortOptions, modelsData?.selected, favoritedModels])

  const applyFilters = useCallback((newFilters: ModelFilters) => {
    setFilters(newFilters)
  }, [])

  const clearFilters = useCallback(() => {
    setFilters({})
    setSortOptions({})
  }, [])

  const applySorting = useCallback((sortOpts: ModelSortOptions) => {
    setSortOptions(sortOpts)
  }, [])

  // sortByField removed - use applySorting with sortOptions instead

  return {
    filteredModels,
    allModels: sourceModels,
    filters,
    sortOptions,
    applyFilters,
    clearFilters,
    applySorting,
    refreshFavorites: () => setFavoritedModels(getFavoritedModels()),
  }
}

export interface TopLevelUserMessageSearchHit {
  conversation_id: ConversationId
  project_id: ProjectId | null
  storage_mode: 'cloud' | 'local'
  conversation_title: string | null
  message_id: string
  message_created_at: string
  conversation_updated_at: string | null
  content: string
  note: string | null
  match_type: 'fts' | 'fuzzy' | 'fallback'
  score: number
}

/**
 * Search top-level user messages across conversations.
 * Electron: Uses local SQLite endpoint with FTS-first + fuzzy fallback.
 * Web: Falls back to existing cloud conversation search endpoint shape.
 */
export function useSearchTopLevelUserMessages(
  projectId?: string | null,
  options?: {
    forceServerSearch?: boolean
  }
) {
  const { accessToken, userId } = useAuth()
  const shouldSearchServer = options?.forceServerSearch ?? true
  const [searchResults, setSearchResults] = useState<TopLevelUserMessageSearchHit[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [searchedFromServer, setSearchedFromServer] = useState(false)

  const searchServer = useCallback(
    async (query: string): Promise<TopLevelUserMessageSearchHit[]> => {
      if (!query.trim()) return []

      if (environment === 'electron') {
        if (!userId) {
          console.warn('[useSearchTopLevelUserMessages] No userId available, skipping local search')
          return []
        }

        const params = new URLSearchParams({ q: query, limit: '20', userId })
        if (projectId) {
          params.set('projectId', projectId)
        }

        try {
          const results = await localApi.get<TopLevelUserMessageSearchHit[]>(
            `/app/conversations/search/top-level-users?${params.toString()}`
          )
          return results || []
        } catch (error) {
          console.error('Local top-level user message search failed:', error)
          return []
        }
      }

      if (!accessToken) {
        console.warn('[useSearchTopLevelUserMessages] No accessToken available, skipping server search')
        return []
      }

      const params = new URLSearchParams({ q: query, limit: '20' })
      const endpoint = projectId
        ? `/search/project?${params.toString()}&projectId=${projectId}`
        : `/search?${params.toString()}`

      try {
        const conversations = await api.get<Conversation[]>(endpoint, accessToken)
        const nowIso = new Date().toISOString()

        return (conversations || []).map(conversation => ({
          conversation_id: conversation.id,
          project_id: conversation.project_id || null,
          storage_mode: conversation.storage_mode === 'local' ? 'local' : 'cloud',
          conversation_title: conversation.title || null,
          message_id: String(conversation.id),
          message_created_at: conversation.updated_at || conversation.created_at || nowIso,
          conversation_updated_at: conversation.updated_at || conversation.created_at || null,
          content: conversation.title
            ? `Title match: ${conversation.title}`
            : 'Conversation title match (message-level search unavailable on this backend)',
          note: null,
          match_type: 'fallback',
          score: 0,
        }))
      } catch (error) {
        console.error('Top-level user message server fallback search failed:', error)
        return []
      }
    },
    [accessToken, projectId, userId]
  )

  const search = useCallback(
    async (query: string) => {
      const trimmed = query.trim()
      if (!trimmed) {
        setSearchResults([])
        setSearchedFromServer(false)
        return
      }

      if (!shouldSearchServer) {
        setSearchResults([])
        setSearchedFromServer(false)
        return
      }

      setIsSearching(true)

      try {
        const serverResults = await searchServer(trimmed)
        setSearchResults(serverResults)
        setSearchedFromServer(true)
      } catch (error) {
        console.error('Top-level user message search failed:', error)
        setSearchResults([])
        setSearchedFromServer(false)
      } finally {
        setIsSearching(false)
      }
    },
    [searchServer, shouldSearchServer]
  )

  const clearSearch = useCallback(() => {
    setSearchResults([])
    setSearchedFromServer(false)
  }, [])

  return {
    search,
    clearSearch,
    searchResults,
    isSearching,
    searchedFromServer,
  }
}

/**
 * Hook for searching conversations by title.
 * Default behavior is local-cache first, then API fallback.
 * When forceServerSearch is enabled, it always hits the API.
 *
 * @param projectId - Optional project ID to scope search
 * @param options - Optional behavior flags
 */
export function useSearchConversations(
  projectId?: string | null,
  options?: {
    forceServerSearch?: boolean
  }
) {
  const queryClient = useQueryClient()
  const { accessToken, userId } = useAuth()
  const forceServerSearch = options?.forceServerSearch ?? false
  const [searchResults, setSearchResults] = useState<Conversation[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [searchedFromServer, setSearchedFromServer] = useState(false)

  // Search local cache first
  const searchLocalCache = useCallback(
    (query: string): Conversation[] => {
      if (!query.trim()) return []

      const lowerQuery = query.toLowerCase()
      const normalizedQuery = lowerQuery.replace(/[\s_-]+/g, '')
      const results: Conversation[] = []
      const seenIds = new Set<string>()

      // Search all cached conversation lists
      const allConversationQueries = queryClient.getQueriesData<
        Conversation[] | { pages: PaginatedConversationsResponse[] }
      >({ queryKey: ['conversations'] })

      for (const [, data] of allConversationQueries) {
        let conversations: Conversation[] = []

        // Handle both flat arrays and infinite query pages
        if (Array.isArray(data)) {
          conversations = data
        } else if (data && typeof data === 'object' && 'pages' in data) {
          conversations = data.pages.flatMap(page => page.conversations)
        }

        for (const conv of conversations) {
          // Skip if already seen or if filtering by project and doesn't match
          if (seenIds.has(String(conv.id))) continue
          if (projectId && conv.project_id !== projectId) continue

          // Case-insensitive title search, with spacing/punctuation-tolerant fallback
          const title = conv.title || ''
          const lowerTitle = title.toLowerCase()
          const normalizedTitle = lowerTitle.replace(/[\s_-]+/g, '')
          if (lowerTitle.includes(lowerQuery) || (normalizedQuery && normalizedTitle.includes(normalizedQuery))) {
            results.push(conv)
            seenIds.add(String(conv.id))
          }
        }
      }

      // Sort by updated_at descending
      return results.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
    },
    [queryClient, projectId]
  )

  // Search API (SQLite local endpoint in Electron, cloud endpoint on web)
  const searchServer = useCallback(
    async (query: string): Promise<Conversation[]> => {
      if (!query.trim()) return []

      if (environment === 'electron') {
        if (!userId) {
          console.warn('[useSearchConversations] No userId available, skipping local search')
          return []
        }

        const params = new URLSearchParams({ q: query, limit: '20', userId })
        if (projectId) {
          params.set('projectId', projectId)
        }

        try {
          const results = await localApi.get<Conversation[]>(`/app/conversations/search?${params.toString()}`)
          return results || []
        } catch (error) {
          console.error('Local conversation title search failed:', error)
          return []
        }
      }

      if (!accessToken) {
        console.warn('[useSearchConversations] No accessToken available, skipping server search')
        return []
      }

      const params = new URLSearchParams({ q: query, limit: '20' })
      const endpoint = projectId
        ? `/search/project?${params.toString()}&projectId=${projectId}`
        : `/search?${params.toString()}`

      try {
        const results = await api.get<Conversation[]>(endpoint, accessToken)
        return results || []
      } catch (error) {
        console.error('Server search failed:', error)
        return []
      }
    },
    [accessToken, projectId, userId]
  )

  // Main search function
  const search = useCallback(
    async (query: string) => {
      const trimmed = query.trim()
      if (!trimmed) {
        setSearchResults([])
        setSearchedFromServer(false)
        return
      }

      setIsSearching(true)

      try {
        if (forceServerSearch) {
          const serverResults = await searchServer(trimmed)
          setSearchResults(serverResults)
          setSearchedFromServer(true)
          return
        }

        // Step 1: Search local cache
        const localResults = searchLocalCache(trimmed)

        if (localResults.length > 0) {
          // Found in local cache, use these results
          setSearchResults(localResults)
          setSearchedFromServer(false)
          return
        }

        // Step 2: Nothing in local cache, search API
        const serverResults = await searchServer(trimmed)
        setSearchResults(serverResults)
        setSearchedFromServer(true)
      } catch (error) {
        console.error('Search failed:', error)
        setSearchResults([])
        setSearchedFromServer(false)
      } finally {
        setIsSearching(false)
      }
    },
    [forceServerSearch, searchLocalCache, searchServer]
  )

  // Clear search results
  const clearSearch = useCallback(() => {
    setSearchResults([])
    setSearchedFromServer(false)
  }, [])

  return {
    search,
    clearSearch,
    searchResults,
    isSearching,
    searchedFromServer,
  }
}

/**
 * User System Prompt type (mirrors server response)
 */
export interface UserSystemPromptCached {
  id: string
  owner_id: string
  name: string
  content: string
  description?: string | null
  is_default: boolean
  created_at: string
  updated_at: string
}

/**
 * Fetch user system prompts with React Query caching
 * Cache key: ['userSystemPrompts', userId]
 *
 * This enables system prompts to be available globally without requiring
 * SettingsPane or EditProject to be opened first.
 *
 * @returns Query result with prompts, default prompt, and utility functions
 */
export function useUserSystemPromptsQuery() {
  const { accessToken, userId } = useAuth()

  const query = useQuery({
    queryKey: ['userSystemPrompts', userId],
    queryFn: async () => {
      if (!userId || !accessToken) return []
      if (isElectronCommunityMode()) return []
      const response = await api.get<UserSystemPromptCached[]>('/system-prompts', accessToken)
      return response || []
    },
    enabled: !!userId && !!accessToken && !isElectronCommunityMode(),
    staleTime: 5 * 60 * 1000, // 5 minutes - prompts don't change often
    refetchOnMount: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
  })

  // Find the default prompt from the cached data
  const defaultPrompt = useMemo(() => {
    if (!query.data) return null
    return query.data.find(p => p.is_default) || null
  }, [query.data])

  return {
    ...query,
    prompts: query.data || [],
    defaultPrompt,
  }
}

/**
 * Helper function to get user system prompts from React Query cache
 * Used by thunks that need to access prompts without a hook
 */
export const getUserSystemPromptsFromCache = (
  queryClient: QueryClient | null,
  userId: string | null
): UserSystemPromptCached[] => {
  if (!queryClient || !userId) return []
  return queryClient.getQueryData<UserSystemPromptCached[]>(['userSystemPrompts', userId]) || []
}

/**
 * Helper function to get the default user system prompt from React Query cache
 * Used by thunks to automatically attach the default prompt to messages
 */
export const getDefaultUserSystemPromptFromCache = (
  queryClient: QueryClient | null,
  userId: string | null
): UserSystemPromptCached | null => {
  const prompts = getUserSystemPromptsFromCache(queryClient, userId)
  return prompts.find(p => p.is_default) || null
}

export interface HtmlToolRecord {
  key: string
  html: string
  label: string | null
  tool_name?: string | null
  favorite: number
  status: 'active' | 'hibernated'
  size_bytes: number
  created_at: number
  updated_at: number
  last_used_at: number
  user_id: string
  conversation_id?: string | null
  project_id?: string | null
}

export const htmlToolsQueryKey = (userId: string | null | undefined) => ['html-tools', userId]

export function useHtmlToolsCache(userId: string | null | undefined, enabled: boolean = true) {
  return useQuery({
    queryKey: htmlToolsQueryKey(userId),
    queryFn: async () => {
      if (!userId || environment !== 'electron') return []
      return localApi.get<HtmlToolRecord[]>(`/local/tools?userId=${userId}`)
    },
    enabled: enabled && !!userId && environment === 'electron',
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnMount: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
  })
}

export const getHtmlToolsFromCache = (queryClient: QueryClient | null, userId: string | null) => {
  if (!queryClient || !userId) return []
  return queryClient.getQueryData<HtmlToolRecord[]>(htmlToolsQueryKey(userId)) || []
}

/**
 * Shared local file browser types
 */
export type DirectoryFileEntry = LocalFileEntry
export type DirectoryListingResponse = LocalFileListingResponse
export type DirectoryFileSearchResponse = LocalFileSearchResponse

/**
 * Global Agent hooks - re-export from dedicated files
 */
export {
  useGlobalAgentQueuedTasks,
  useGlobalAgentMessages,
  useGlobalAgentOptimisticMessage,
  useRemoveGlobalAgentQueuedTask,
  useGlobalAgentStreamBuffer,
} from './useGlobalAgentMessages'
export type {
  GlobalAgentMessagesData,
  GlobalAgentQueuedTask,
  GlobalAgentQueuedTasksData,
} from './useGlobalAgentMessages'

/**
 * Fetch files from a directory path
 * Cache key: ['directory-files', path]
 *
 * Only available in electron/local mode for security
 * Returns file list sorted with directories first
 *
 * @param directoryPath - The directory path to list files from
 * @returns Query result with files array
 */
export function useDirectoryFiles(directoryPath: string | null | undefined) {
  return useQuery({
    queryKey: ['directory-files', directoryPath],
    queryFn: async () => {
      if (!directoryPath) throw new Error('Directory path is required')

      // Use local API for file system access (electron mode)
      const params = new URLSearchParams({ path: directoryPath })
      return localApi.get<DirectoryListingResponse>(`/local/files?${params}`)
    },
    enabled: !!directoryPath && directoryPath.trim().length > 0 && environment !== 'web',
    staleTime: 30 * 1000, // 30 seconds - files can change frequently
    refetchOnMount: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
  })
}

/**
 * Search files and directories recursively from a root path
 * Cache key: ['directory-files-search', path, query, followGitignore, limit]
 *
 * Only available in electron/local mode for security
 * Returns both file and directory matches, including relative paths
 */
export function useDirectoryFileSearch(
  directoryPath: string | null | undefined,
  query: string | null | undefined,
  followGitignore = true,
  limit = 200
) {
  const normalizedQuery = String(query || '').trim()

  return useQuery({
    queryKey: ['directory-files-search', directoryPath, normalizedQuery, followGitignore, limit],
    queryFn: async () => {
      if (!directoryPath) throw new Error('Directory path is required')
      if (!normalizedQuery) throw new Error('Search query is required')

      const params = new URLSearchParams({
        path: directoryPath,
        query: normalizedQuery,
        followGitignore: followGitignore ? '1' : '0',
      })

      if (Number.isFinite(limit)) {
        params.set('limit', String(Math.max(1, Math.floor(limit))))
      }

      return localApi.get<DirectoryFileSearchResponse>(`/local/files/search?${params}`)
    },
    enabled: !!directoryPath && directoryPath.trim().length > 0 && normalizedQuery.length > 0 && environment !== 'web',
    staleTime: 30 * 1000,
    refetchOnMount: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
  })
}

/**
 * Shared local git types
 */
export type GitRepoSummary = LocalGitRepoSummary
export type GitStatusFile = LocalGitStatusFile
export type GitCommit = LocalGitCommit
export type GitBranch = LocalGitBranch
export type GitOverviewResponse = LocalGitOverviewResponse
export type GitDiffResponse = LocalGitDiffResponse

const gitOverviewQueryKey = (directoryPath: string | null | undefined) => ['local-git', 'overview', directoryPath]
const gitDiffQueryKey = (
  directoryPath: string | null | undefined,
  relativePath: string | null | undefined,
  staged: boolean
) => ['local-git', 'diff', directoryPath, relativePath, staged]

export function useGitOverview(directoryPath: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: gitOverviewQueryKey(directoryPath),
    queryFn: async () => {
      if (!directoryPath) throw new Error('Directory path is required')
      const params = new URLSearchParams({ path: directoryPath })
      return localApi.get<LocalGitOverviewResponse>(`/local/git/overview?${params}`)
    },
    enabled: enabled && !!directoryPath && directoryPath.trim().length > 0 && environment === 'electron',
    staleTime: 10 * 1000,
    refetchOnMount: 'always',
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
  })
}

export function useGitDiff(
  directoryPath: string | null | undefined,
  relativePath: string | null | undefined,
  staged: boolean,
  enabled = true
) {
  const normalizedRelativePath = String(relativePath || '').trim()

  return useQuery({
    queryKey: gitDiffQueryKey(directoryPath, normalizedRelativePath, staged),
    queryFn: async () => {
      if (!directoryPath) throw new Error('Directory path is required')
      if (!normalizedRelativePath) throw new Error('Relative path is required')

      const params = new URLSearchParams({
        path: directoryPath,
        file: normalizedRelativePath,
        staged: staged ? '1' : '0',
      })
      return localApi.get<LocalGitDiffResponse>(`/local/git/diff?${params}`)
    },
    enabled:
      enabled &&
      !!directoryPath &&
      directoryPath.trim().length > 0 &&
      normalizedRelativePath.length > 0 &&
      environment === 'electron',
    staleTime: 5 * 1000,
    refetchOnMount: 'always',
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
  })
}

function invalidateGitQueries(queryClient: QueryClient) {
  queryClient.invalidateQueries({ queryKey: ['local-git'] })
}

export function useGitStageFiles() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (payload: { path: string; files?: string[] }) => {
      if (!payload?.path) throw new Error('Repository path is required')
      return localApi.post<LocalGitActionResponse>('/local/git/stage', payload)
    },
    onSuccess: () => {
      invalidateGitQueries(queryClient)
      queryClient.invalidateQueries({ queryKey: ['directory-files'] })
      queryClient.invalidateQueries({ queryKey: ['directory-files-search'] })
    },
  })
}

export function useGitUnstageFiles() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (payload: { path: string; files: string[] }) => {
      if (!payload?.path) throw new Error('Repository path is required')
      if (!payload?.files?.length) throw new Error('At least one file is required')
      return localApi.post<LocalGitActionResponse>('/local/git/unstage', payload)
    },
    onSuccess: () => {
      invalidateGitQueries(queryClient)
    },
  })
}

export function useGitCheckoutBranch() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (payload: { path: string; branch: string }) => {
      if (!payload?.path) throw new Error('Repository path is required')
      if (!payload?.branch?.trim()) throw new Error('Branch name is required')
      return localApi.post<LocalGitActionResponse>('/local/git/checkout', {
        path: payload.path,
        branch: payload.branch.trim(),
      })
    },
    onSuccess: () => {
      invalidateGitQueries(queryClient)
      queryClient.invalidateQueries({ queryKey: ['directory-files'] })
      queryClient.invalidateQueries({ queryKey: ['directory-files-search'] })
    },
  })
}

export function useGitCreateBranch() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (payload: { path: string; branch: string; checkout?: boolean }) => {
      if (!payload?.path) throw new Error('Repository path is required')
      if (!payload?.branch?.trim()) throw new Error('Branch name is required')
      return localApi.post<LocalGitActionResponse>('/local/git/branch', {
        path: payload.path,
        branch: payload.branch.trim(),
        checkout: payload.checkout !== false,
      })
    },
    onSuccess: () => {
      invalidateGitQueries(queryClient)
      queryClient.invalidateQueries({ queryKey: ['directory-files'] })
      queryClient.invalidateQueries({ queryKey: ['directory-files-search'] })
    },
  })
}
