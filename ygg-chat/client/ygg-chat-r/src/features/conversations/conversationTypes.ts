import { ConversationId, ProjectId } from '../../../../../shared/types'

export interface Conversation {
  id: ConversationId
  user_id: string
  title: string | null
  project_id?: ProjectId | null
  created_at: string
  updated_at: string
  system_prompt: string | null
  conversation_context: string | null
  research_note: string | null
  cwd?: string | null
  /** JSON array of extra working directories (local column); NULL means none. */
  additional_cwds?: string | null
  favorite?: number
}

export interface ConversationsState {
  items: Conversation[]
  loading: boolean
  error: string | null
  activeConversationId: ConversationId | null
  systemPrompt: string | null
  convContext: string | null
  // Recently updated conversations for quick access
  recent: RecentConversationsState
  // Note: recentModels removed - now managed by React Query (useRecentModels hook)
}

export interface RecentConversationsState {
  items: Conversation[]
  loading: boolean
  error: string | null
}
