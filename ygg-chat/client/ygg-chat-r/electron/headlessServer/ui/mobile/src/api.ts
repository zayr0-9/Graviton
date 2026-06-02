import type {
  HeadlessSseEvent,
  LocalUserProfile,
  MobileConversation,
  MobileCustomTool,
  MobileInferenceTool,
  MobileLocalFileListingResponse,
  MobileLocalFileSearchResponse,
  MobileMessage,
  MobileMessageTreePayload,
  MobileProject,
  MobileProviderModelInfo,
  MobileProviderName,
} from './types'

const jsonFetch = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(url, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers || {}),
    },
  })

  let payload: any = {}
  try {
    payload = await response.json()
  } catch {
    payload = {}
  }

  if (!response.ok) {
    throw new Error(payload?.error || `HTTP ${response.status}`)
  }

  return payload as T
}

const parseSseChunk = (chunk: string, onEvent: (event: HeadlessSseEvent) => void) => {
  const lines = String(chunk || '').split('\n')
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line.startsWith('data:')) continue

    const payload = line.slice(5).trim()
    if (!payload) continue

    try {
      onEvent(JSON.parse(payload) as HeadlessSseEvent)
    } catch {
      // ignore malformed payload lines
    }
  }
}

const readRuntimeAppSession = async (): Promise<{ accessToken: string | null; userId: string | null }> => {
  try {
    if (typeof window !== 'undefined' && (window as any).electronAPI?.storage?.get) {
      const stored = await (window as any).electronAPI.storage.get('auth_session')
      const accessToken = stored?.accessToken || stored?.session?.access_token || null
      const userId = stored?.userId || stored?.user?.id || stored?.session?.user?.id || null
      if (accessToken) {
        return {
          accessToken: String(accessToken),
          userId: userId ? String(userId) : null,
        }
      }
    }
  } catch {
    // fall through to localStorage fallback
  }

  try {
    if (typeof window !== 'undefined') {
      const raw = window.localStorage.getItem('supabase-auth-token')
      if (raw) {
        const parsed = JSON.parse(raw)
        const session = parsed?.currentSession || parsed?.session || parsed
        const accessToken = session?.access_token || null
        const userId = session?.user?.id || null
        if (accessToken) {
          return {
            accessToken: String(accessToken),
            userId: userId ? String(userId) : null,
          }
        }
      }
    }
  } catch {
    // ignore localStorage parse failures
  }

  return { accessToken: null, userId: null }
}

export const mobileApi = {
  async listUsers(): Promise<LocalUserProfile[]> {
    const payload = await jsonFetch<LocalUserProfile[]>('/api/local/users', { method: 'GET' })
    return Array.isArray(payload) ? payload : []
  },

  async listProjects(userId: string): Promise<MobileProject[]> {
    const payload = await jsonFetch<MobileProject[]>(`/api/app/projects?userId=${encodeURIComponent(userId)}`, { method: 'GET' })
    return Array.isArray(payload) ? payload : []
  },

  async createProject(params: { userId: string; name: string }): Promise<MobileProject> {
    return jsonFetch<MobileProject>('/api/app/projects', {
      method: 'POST',
      body: JSON.stringify({
        user_id: params.userId,
        name: params.name,
      }),
    })
  },

  async updateProject(
    projectId: string,
    patch: {
      name?: string
      context?: string | null
      system_prompt?: string | null
    }
  ): Promise<MobileProject> {
    return jsonFetch<MobileProject>(`/api/app/projects/${encodeURIComponent(projectId)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    })
  },

  async listConversations(userId: string, projectId?: string | null): Promise<MobileConversation[]> {
    const query = new URLSearchParams({ userId })

    if (projectId === null) {
      query.set('projectId', '__none__')
    } else if (projectId) {
      query.set('projectId', projectId)
    }

    const payload = await jsonFetch<MobileConversation[]>(`/api/app/conversations?${query.toString()}`, {
      method: 'GET',
    })
    return Array.isArray(payload) ? payload : []
  },

  async createConversation(params: {
    userId: string
    projectId?: string | null
    title?: string
    cwd?: string | null
  }): Promise<MobileConversation> {
    return jsonFetch<MobileConversation>('/api/app/conversations', {
      method: 'POST',
      body: JSON.stringify({
        user_id: params.userId,
        project_id: params.projectId || null,
        title: params.title || 'New Conversation',
        cwd: params.cwd || null,
      }),
    })
  },

  async updateConversation(
    conversationId: string,
    patch: {
      cwd?: string | null
      title?: string
      system_prompt?: string | null
      conversation_context?: string | null
    }
  ): Promise<MobileConversation> {
    return jsonFetch<MobileConversation>(`/api/app/conversations/${encodeURIComponent(conversationId)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    })
  },

  async getConversation(conversationId: string): Promise<MobileConversation | null> {
    try {
      const payload = await jsonFetch<MobileConversation>(`/api/app/conversations/${encodeURIComponent(conversationId)}`, {
        method: 'GET',
      })
      return payload || null
    } catch {
      return null
    }
  },

  async getLatestConversation(userId: string): Promise<MobileConversation | null> {
    try {
      const payload = await jsonFetch<MobileConversation | null>(
        `/api/app/conversations/latest?userId=${encodeURIComponent(userId)}`,
        {
          method: 'GET',
        }
      )
      return payload || null
    } catch {
      return null
    }
  },

  async listMessages(conversationId: string): Promise<MobileMessage[]> {
    const payload = await jsonFetch<MobileMessage[]>(`/api/app/conversations/${encodeURIComponent(conversationId)}/messages`, {
      method: 'GET',
    })
    return Array.isArray(payload) ? payload : []
  },

  async getConversationMessageTree(conversationId: string): Promise<MobileMessageTreePayload> {
    const payload = await jsonFetch<MobileMessageTreePayload>(
      `/api/app/conversations/${encodeURIComponent(conversationId)}/messages/tree`,
      {
        method: 'GET',
      }
    )

    return {
      messages: Array.isArray(payload?.messages) ? payload.messages : [],
      tree: payload?.tree || null,
      meta: payload?.meta,
    }
  },

  async listLocalFiles(directoryPath: string): Promise<MobileLocalFileListingResponse> {
    const payload = await jsonFetch<Partial<MobileLocalFileListingResponse>>(
      `/api/local/files?path=${encodeURIComponent(directoryPath)}`,
      { method: 'GET' }
    )

    return {
      path: typeof payload?.path === 'string' ? payload.path : directoryPath,
      files: Array.isArray(payload?.files) ? payload.files : [],
    }
  },

  async searchLocalFiles(params: {
    directoryPath: string
    query: string
    limit?: number
    followGitignore?: boolean
  }): Promise<MobileLocalFileSearchResponse> {
    const query = String(params.query || '').trim()
    if (!query) {
      return {
        path: params.directoryPath,
        query: '',
        files: [],
        truncated: false,
        respectingGitignore: Boolean(params.followGitignore ?? true),
      }
    }

    const searchParams = new URLSearchParams({
      path: params.directoryPath,
      query,
    })

    if (typeof params.limit === 'number' && Number.isFinite(params.limit)) {
      searchParams.set('limit', String(Math.max(1, Math.floor(params.limit))))
    }

    searchParams.set('followGitignore', params.followGitignore === false ? '0' : '1')

    const payload = await jsonFetch<Partial<MobileLocalFileSearchResponse>>(
      `/api/local/files/search?${searchParams.toString()}`,
      { method: 'GET' }
    )

    return {
      path: typeof payload?.path === 'string' ? payload.path : params.directoryPath,
      query: typeof payload?.query === 'string' ? payload.query : query,
      files: Array.isArray(payload?.files) ? payload.files : [],
      truncated: Boolean(payload?.truncated),
      respectingGitignore: Boolean(payload?.respectingGitignore),
    }
  },

  async getLocalFileContent(filePath: string): Promise<{ path: string; content: string; size: number }> {
    const payload = await jsonFetch<{ path?: string; content?: string; size?: number }>(
      `/api/local/file-content?path=${encodeURIComponent(filePath)}`,
      { method: 'GET' }
    )

    return {
      path: typeof payload?.path === 'string' ? payload.path : filePath,
      content: typeof payload?.content === 'string' ? payload.content : '',
      size: typeof payload?.size === 'number' ? payload.size : 0,
    }
  },

  async saveLocalFileContent(filePath: string, content: string): Promise<{ path: string; size: number; saved: boolean }> {
    const payload = await jsonFetch<{ path?: string; size?: number; saved?: boolean }>('/api/local/file-content', {
      method: 'POST',
      body: JSON.stringify({
        path: filePath,
        content,
      }),
    })

    return {
      path: typeof payload?.path === 'string' ? payload.path : filePath,
      size: typeof payload?.size === 'number' ? payload.size : content.length,
      saved: Boolean(payload?.saved),
    }
  },

  async getCapabilities(): Promise<any> {
    return jsonFetch('/api/headless/capabilities?includeCustomTools=false', { method: 'GET' })
  },

  async getProviderModels(userId?: string | null): Promise<MobileProviderModelInfo[]> {
    const query = typeof userId === 'string' && userId.trim() ? `?userId=${encodeURIComponent(userId.trim())}` : ''
    const payload = await jsonFetch<{
      success?: boolean
      providers?: Array<{ name?: string; models?: string[] }>
    }>(`/api/provider-auth/models${query}`, { method: 'GET' })

    return Array.isArray(payload?.providers)
      ? payload.providers
          .filter(
            (provider): provider is { name: MobileProviderName; models?: string[] } =>
              Boolean(
                provider &&
                  (provider.name === 'openaichatgpt' ||
                    provider.name === 'openrouter' ||
                    provider.name === 'lmstudio' ||
                    provider.name === 'zai' ||
                    provider.name === 'bedrock')
              )
          )
          .map(provider => ({
            name: provider.name,
            models: Array.isArray(provider.models) ? provider.models.map(model => String(model)) : [],
          }))
      : []
  },

  async listInferenceTools(): Promise<MobileInferenceTool[]> {
    const payload = await jsonFetch<{
      success?: boolean
      tools?: Array<{ name?: string; description?: string; inputSchema?: Record<string, unknown> }>
    }>('/api/headless/ephemeral/tools?includeCustomTools=false', { method: 'GET' })

    const tools = Array.isArray(payload?.tools) ? payload.tools : []
    return tools
      .filter((tool): tool is { name: string; description?: string; inputSchema?: Record<string, unknown> } =>
        Boolean(tool && typeof tool.name === 'string' && tool.name.trim())
      )
      .map(tool => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }))
  },

  async listCustomTools(): Promise<MobileCustomTool[]> {
    const payload = await jsonFetch<{ success?: boolean; tools?: MobileCustomTool[] }>('/api/headless/custom-tools', {
      method: 'GET',
    })
    return Array.isArray(payload?.tools) ? payload.tools : []
  },

  async setCustomToolEnabled(name: string, enabled: boolean): Promise<void> {
    await jsonFetch(`/api/headless/custom-tools/${encodeURIComponent(name)}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    })
  },

  async getProviderTokenStatus(provider: 'openai' | 'openrouter' | 'zai' | 'bedrock', userId: string): Promise<{ hasToken: boolean }> {
    const payload = await jsonFetch<{ success: boolean; hasToken?: boolean }>(
      `/api/provider-auth/${provider}/token?userId=${encodeURIComponent(userId)}`,
      { method: 'GET' }
    )
    return { hasToken: Boolean(payload?.hasToken) }
  },

  async getOpenAiTokenStatus(userId: string): Promise<{ hasToken: boolean }> {
    return this.getProviderTokenStatus('openai', userId)
  },

  async getOpenRouterTokenStatus(userId: string): Promise<{ hasToken: boolean }> {
    return this.getProviderTokenStatus('openrouter', userId)
  },

  async getZaiTokenStatus(userId: string): Promise<{ hasToken: boolean }> {
    return this.getProviderTokenStatus('zai', userId)
  },

  async getBedrockTokenStatus(userId: string): Promise<{ hasToken: boolean }> {
    return this.getProviderTokenStatus('bedrock', userId)
  },

  async getRuntimeAppAuth(): Promise<{ hasToken: boolean; accessToken: string | null; userId: string | null }> {
    const session = await readRuntimeAppSession()
    return {
      hasToken: Boolean(session.accessToken),
      accessToken: session.accessToken,
      userId: session.userId,
    }
  },

  async clearProviderToken(provider: 'openai' | 'openrouter' | 'zai' | 'bedrock', userId: string): Promise<void> {
    await jsonFetch(`/api/provider-auth/${provider}/token?userId=${encodeURIComponent(userId)}`, {
      method: 'DELETE',
    })
  },

  async clearOpenAiToken(userId: string): Promise<void> {
    await this.clearProviderToken('openai', userId)
  },

  async clearOpenRouterToken(userId: string): Promise<void> {
    await this.clearProviderToken('openrouter', userId)
  },

  async clearZaiToken(userId: string): Promise<void> {
    await this.clearProviderToken('zai', userId)
  },

  async clearBedrockToken(userId: string): Promise<void> {
    await this.clearProviderToken('bedrock', userId)
  },

  async startOpenAiOAuth(): Promise<{ authUrl: string; state: string }> {
    const payload = await jsonFetch<{ success?: boolean; authUrl?: string; state?: string; error?: string }>(
      '/api/openai/auth/start',
      {
        method: 'POST',
        body: JSON.stringify({}),
      }
    )

    if (!payload?.success || !payload?.authUrl || !payload?.state) {
      throw new Error(payload?.error || 'Failed to start OpenAI OAuth flow')
    }

    return {
      authUrl: payload.authUrl,
      state: payload.state,
    }
  },

  async completeOpenAiOAuth(state: string): Promise<{
    pending: boolean
    accessToken?: string
    refreshToken?: string
    expiresAt?: number
    accountId?: string
  }> {
    const payload = await jsonFetch<{
      success?: boolean
      pending?: boolean
      accessToken?: string
      refreshToken?: string
      expiresAt?: number
      accountId?: string
      error?: string
    }>('/api/openai/auth/complete', {
      method: 'POST',
      body: JSON.stringify({ state }),
    })

    if (payload?.pending) {
      return { pending: true }
    }

    if (!payload?.success || !payload?.accessToken || !payload?.refreshToken || !payload?.accountId) {
      throw new Error(payload?.error || 'OpenAI OAuth completion failed')
    }

    return {
      pending: false,
      accessToken: payload.accessToken,
      refreshToken: payload.refreshToken,
      expiresAt: payload.expiresAt,
      accountId: payload.accountId,
    }
  },

  async storeOpenAiToken(params: {
    userId: string
    accessToken: string
    refreshToken: string
    expiresAt?: number
    accountId: string
  }): Promise<void> {
    await jsonFetch('/api/provider-auth/openai/token', {
      method: 'POST',
      body: JSON.stringify({
        userId: params.userId,
        accessToken: params.accessToken,
        refreshToken: params.refreshToken,
        expiresAt: params.expiresAt,
        accountId: params.accountId,
      }),
    })
  },

  async storeOpenRouterToken(params: {
    userId: string
    accessToken: string
  }): Promise<void> {
    await jsonFetch('/api/provider-auth/openrouter/token', {
      method: 'POST',
      body: JSON.stringify({
        userId: params.userId,
        accessToken: params.accessToken,
      }),
    })
  },

  async storeZaiToken(params: {
    userId: string
    accessToken: string
  }): Promise<void> {
    await jsonFetch('/api/provider-auth/zai/token', {
      method: 'POST',
      body: JSON.stringify({
        userId: params.userId,
        accessToken: params.accessToken,
      }),
    })
  },

  async storeBedrockToken(params: {
    userId: string
    accessToken: string
  }): Promise<void> {
    await jsonFetch('/api/provider-auth/bedrock/token', {
      method: 'POST',
      body: JSON.stringify({
        userId: params.userId,
        accessToken: params.accessToken,
      }),
    })
  },

  async deleteMessage(messageId: string): Promise<void> {
    await jsonFetch(`/api/app/messages/${encodeURIComponent(messageId)}`, {
      method: 'DELETE',
    })
  },

  async streamMessage(params: {
    conversationId: string
    userId: string
    provider: MobileProviderName
    modelName: string
    content: string
    parentId?: string | null
    operation?: 'send' | 'branch' | 'edit-branch'
    messageId?: string | null
    cwd?: string | null
    rootPath?: string | null
    tools?: MobileInferenceTool[]
    onEvent: (event: HeadlessSseEvent) => void
  }): Promise<void> {
    const operation = params.operation || 'send'
    const endpoint =
      operation === 'send'
        ? `/api/conversations/${encodeURIComponent(params.conversationId)}/messages`
        : `/api/conversations/${encodeURIComponent(params.conversationId)}/messages/${encodeURIComponent(
            params.messageId || ''
          )}/${operation}`

    if (operation !== 'send' && !params.messageId) {
      throw new Error(`${operation} requires messageId`)
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: params.content,
        provider: params.provider,
        modelName: params.modelName,
        userId: params.userId,
        parentId: params.parentId ?? null,
        rootPath: params.rootPath ?? params.cwd ?? null,
        cwd: params.cwd ?? params.rootPath ?? null,
        tools: Array.isArray(params.tools) && params.tools.length > 0 ? params.tools : undefined,
      }),
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`Send failed: HTTP ${response.status} ${text}`)
    }

    let streamError: string | null = null
    let sawTerminalEvent = false
    const onEventWithErrorCapture = (event: HeadlessSseEvent) => {
      if (event && typeof event === 'object') {
        const eventType = (event as any).type
        if (eventType === 'error') {
          const errorText = (event as any).error
          streamError = typeof errorText === 'string' && errorText.trim().length > 0 ? errorText : 'Headless stream error'
          sawTerminalEvent = true
        } else if (eventType === 'complete') {
          sawTerminalEvent = true
        }
      }
      params.onEvent(event)
    }

    if (!response.body) {
      const text = await response.text()
      parseSseChunk(text, onEventWithErrorCapture)
      if (streamError) {
        throw new Error(streamError)
      }
      if (!sawTerminalEvent) {
        throw new Error('Stream ended without terminal event (no complete/error)')
      }
      return
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      const cut = buffer.lastIndexOf('\n\n')
      if (cut === -1) continue

      const chunk = buffer.slice(0, cut)
      buffer = buffer.slice(cut + 2)
      parseSseChunk(chunk, onEventWithErrorCapture)
    }

    if (buffer.trim()) {
      parseSseChunk(buffer, onEventWithErrorCapture)
    }

    if (streamError) {
      throw new Error(streamError)
    }

    if (!sawTerminalEvent) {
      throw new Error('Stream ended without terminal event (no complete/error)')
    }
  },
}
