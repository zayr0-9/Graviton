import { v4 as uuidv4 } from 'uuid'
import { QueryClient } from '@tanstack/react-query'
import { loadAgentSettings, AgentSettings } from '../helpers/agentSettingsStorage'
import { createStreamingRequest, localApi } from '../utils/api'
import { getAllTools, getToolsForAI } from '../features/chats/toolDefinitions'
import { executeLocalTool } from '../features/chats/chatActions'
import { abortSubagentControllers } from '../features/chats/subagentClient'
import {
  updateGlobalAgentMessageCache,
  clearGlobalAgentOptimisticMessage,
  updateGlobalAgentStreamBuffer,
  clearGlobalAgentStreamBuffer,
  getGlobalAgentStreamBuffer
} from '../hooks/useGlobalAgentCache'
import type { RootState } from '../store/store'

export type GlobalAgentStatus = 'idle' | 'running' | 'paused' | 'error'

export type GlobalAgentState = {
  status: GlobalAgentStatus
  sessionId: number | null
  conversationId: string | null
  streamId: string | null
  lastRunAt: string | null
  nextRunAt: string | null
  error: string | null
}

export type GlobalAgentStreamEvent = {
  streamId: string
  delta: string
  kind: 'text' | 'reasoning' | 'tool_call' | 'tool_result'
}

export type GlobalAgentMessageEvent = {
  messageId: string
  role: string
  content: string
}

export type GlobalAgentEvent =
  | { type: 'state'; state: GlobalAgentState }
  | { type: 'stream'; data: GlobalAgentStreamEvent }
  | { type: 'message'; data: GlobalAgentMessageEvent }
  | { type: 'error'; error: string }

export type GlobalAgentSchedulePreset = 'custom' | 'hourly' | 'every_4_hours' | 'every_6_hours' | 'daily'

export type GlobalAgentTaskSchedule = {
  repeatCount: number
  intervalMs: number
  preset: GlobalAgentSchedulePreset
  startDate?: string | null
  endDate?: string | null
  allowedWeekdays?: number[]
}

type ScheduledTaskMeta = {
  runAt: string
  sequence: number
  total: number
  intervalMs: number
  preset: GlobalAgentSchedulePreset
  startDate: string | null
  endDate: string | null
  allowedWeekdays: number[]
}

class GlobalAgentLoop {
  private static instance: GlobalAgentLoop | null = null
  private initialized = false
  private running = false
  private busy = false
  private state: GlobalAgentState = {
    status: 'idle',
    sessionId: null,
    conversationId: null,
    streamId: null,
    lastRunAt: null,
    nextRunAt: null,
    error: null,
  }
  private settings: AgentSettings | null = null
  private userId: string | null = null
  private accessToken: string | null = null
  private timer: number | null = null
  private heartbeatLastDate: string | null = null
  private systemProjectId: string | null = null
  private listeners: Set<(event: GlobalAgentEvent) => void> = new Set()
  private queryClient: QueryClient | null = null
  private dispatch: any = null
  private reduxGetState: (() => RootState) | null = null
  private streamAbortController: AbortController | null = null

  static getInstance(): GlobalAgentLoop {
    if (!GlobalAgentLoop.instance) {
      GlobalAgentLoop.instance = new GlobalAgentLoop()
    }
    return GlobalAgentLoop.instance
  }

  /**
   * Inject React Query client for cache updates
   * @param queryClient - QueryClient instance from React app
   */
  setQueryClient(queryClient: QueryClient | null): void {
    this.queryClient = queryClient
  }

  /**
   * Inject Redux dispatch and getState for tool execution (especially subagent)
   * @param dispatch - Redux dispatch function
   * @param getState - Redux getState function
   */
  setReduxContext(dispatch: any, getState: (() => RootState) | null): void {
    this.dispatch = dispatch
    this.reduxGetState = getState
  }

  on(listener: (event: GlobalAgentEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(event: GlobalAgentEvent) {
    for (const listener of this.listeners) {
      listener(event)
    }
  }

  async initialize(userId: string | null, accessToken: string | null): Promise<void> {
    if (this.initialized) return
    this.userId = userId
    this.accessToken = accessToken

    this.settings = await loadAgentSettings()
    const stateResponse = await localApi.get<{ success: boolean; state: any }>('/agent/state')
    if (stateResponse?.state) {
      this.state = {
        status: (stateResponse.state.status as GlobalAgentStatus) || 'idle',
        sessionId: stateResponse.state.session_id ?? null,
        conversationId: stateResponse.state.conversation_id ?? null,
        streamId: stateResponse.state.stream_id ?? null,
        lastRunAt: stateResponse.state.last_run_at ?? null,
        nextRunAt: stateResponse.state.next_run_at ?? null,
        error: null,
      }
    }

    // Streams cannot survive app restart. Clear any persisted stream marker to avoid phantom "active stream" blocks.
    if (this.state.streamId) {
      this.state.streamId = null
      try {
        await localApi.put('/agent/state', { streamId: null })
      } catch (error) {
        console.warn('[GlobalAgentLoop] Failed to clear stale streamId during initialize:', error)
      }
      this.emit({ type: 'state', state: { ...this.state } })
    }

    await this.ensureSystemProjectAndSession()

    if (this.settings?.autoResume && this.state.status === 'running') {
      this.start()
    }

    this.initialized = true
    this.emit({ type: 'state', state: { ...this.state } })
  }

  async refreshSettings(): Promise<void> {
    this.settings = await loadAgentSettings()
  }

  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    this.state.status = 'running'
    await localApi.put('/agent/state', { status: 'running' })
    this.emit({ type: 'state', state: { ...this.state } })

    const interval = this.settings?.loopIntervalMs ?? 60000
    this.timer = window.setInterval(() => {
      this.runTick().catch(err => {
        console.error('[GlobalAgentLoop] Tick error:', err)
        this.state.error = err instanceof Error ? err.message : String(err)
        this.emit({ type: 'error', error: this.state.error })
      })
    }, interval)

    await this.runTick()
  }

  async pause(): Promise<void> {
    this.running = false
    this.state.status = 'paused'
    if (this.timer) {
      window.clearInterval(this.timer)
      this.timer = null
    }
    await localApi.put('/agent/state', { status: 'paused' })
    this.emit({ type: 'state', state: { ...this.state } })
  }

  async stop(): Promise<void> {
    this.running = false
    this.state.status = 'idle'
    if (this.timer) {
      window.clearInterval(this.timer)
      this.timer = null
    }
    await localApi.put('/agent/state', { status: 'stopped' })
    this.emit({ type: 'state', state: { ...this.state } })
  }

  async abortCurrentGeneration(): Promise<void> {
    if (this.streamAbortController) {
      this.streamAbortController.abort()
      this.streamAbortController = null
    }

    // Abort any in-flight subagent stream started under this agent's stream id.
    abortSubagentControllers(this.state.streamId)

    if (this.queryClient) {
      clearGlobalAgentStreamBuffer(this.queryClient)
    }

    if (this.state.streamId) {
      this.state.streamId = null
      try {
        await localApi.put('/agent/state', { streamId: null })
      } catch (error) {
        console.warn('[GlobalAgentLoop] Failed to clear streamId after abort:', error)
      }
      this.emit({ type: 'state', state: { ...this.state } })
    }
  }

  async startNewSession(reason: string = 'manual'): Promise<void> {
    if (!this.userId || !this.systemProjectId) {
      await this.ensureSystemProjectAndSession()
    }
    if (!this.userId || !this.systemProjectId) return

    if (this.state.sessionId) {
      await localApi.post('/agent/session/end', {
        sessionId: this.state.sessionId,
        rolloverReason: reason,
      })
    }

    const newConversation = await localApi.post<{ id: string }>('/app/conversations', {
      user_id: this.userId,
      project_id: this.systemProjectId,
      title: this.settings?.agentName || 'Global Agent',
      cwd: this.getConfiguredWorkDirectory(),
      storage_mode: 'local',
    })

    const session = await localApi.post<{ session: { id: number } }>('/agent/session/start', {
      conversationId: newConversation.id,
      rolloverReason: reason,
    })

    this.state.conversationId = newConversation.id
    this.state.sessionId = session?.session?.id ?? null
    await localApi.put('/agent/state', {
      conversationId: this.state.conversationId,
      sessionId: this.state.sessionId,
    })

    // Invalidate cache so next render fetches new conversation
    if (this.queryClient) {
      this.queryClient.invalidateQueries({ queryKey: ['globalAgent', 'messages'] })
    }

    this.emit({ type: 'state', state: { ...this.state } })
  }

  async enqueueTask(description: string, payload?: any, source?: string, schedule?: GlobalAgentTaskSchedule): Promise<void> {
    if (schedule) {
      await this.enqueueScheduledTasks(description, payload, source, schedule)
    } else {
      await localApi.post('/agent/tasks', { description, payload, source })
    }
    await this.runTick()
  }

  getState(): GlobalAgentState {
    return { ...this.state }
  }

  private getConfiguredWorkDirectory(): string | null {
    const value = this.settings?.workDirectory
    if (typeof value !== 'string') return null
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
  }

  private normalizeWeekdays(input?: number[]): number[] {
    if (!Array.isArray(input)) {
      return [0, 1, 2, 3, 4, 5, 6]
    }
    const unique = Array.from(
      new Set(
        input
          .map(value => Math.floor(value))
          .filter(value => Number.isFinite(value) && value >= 0 && value <= 6)
      )
    )
    return unique.length > 0 ? unique.sort((a, b) => a - b) : [0, 1, 2, 3, 4, 5, 6]
  }

  private parseDateBoundary(value: string | null | undefined, endOfDay: boolean): Date | null {
    if (typeof value !== 'string' || value.trim().length === 0) return null
    const parsed = new Date(`${value}${endOfDay ? 'T23:59:59.999' : 'T00:00:00.000'}`)
    if (Number.isNaN(parsed.getTime())) return null
    return parsed
  }

  private computeScheduledRunTimes(schedule: GlobalAgentTaskSchedule): Date[] {
    const repeatCount = Math.max(1, Math.min(500, Math.floor(schedule.repeatCount || 1)))
    const intervalMs = Math.max(1000, Math.floor(schedule.intervalMs || 1000))
    const allowedWeekdays = this.normalizeWeekdays(schedule.allowedWeekdays)
    const startBoundary = this.parseDateBoundary(schedule.startDate, false)
    const endBoundary = this.parseDateBoundary(schedule.endDate, true)

    if (startBoundary && endBoundary && startBoundary.getTime() > endBoundary.getTime()) {
      return []
    }

    const results: Date[] = []
    let candidate = new Date()
    const maxIterations = repeatCount * 128
    let iterations = 0

    while (results.length < repeatCount && iterations < maxIterations) {
      if (startBoundary && candidate.getTime() < startBoundary.getTime()) {
        candidate = new Date(startBoundary.getTime())
      }
      if (endBoundary && candidate.getTime() > endBoundary.getTime()) {
        break
      }

      if (allowedWeekdays.includes(candidate.getDay())) {
        results.push(new Date(candidate.getTime()))
      }

      candidate = new Date(candidate.getTime() + intervalMs)
      iterations += 1
    }

    return results
  }

  private buildScheduledTaskPayload(payload: any, scheduleMeta: ScheduledTaskMeta): any {
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      return {
        ...payload,
        __globalSchedule: scheduleMeta,
      }
    }
    if (payload === undefined) {
      return { __globalSchedule: scheduleMeta }
    }
    return {
      value: payload,
      __globalSchedule: scheduleMeta,
    }
  }

  private parseTaskPayload(task: any): any {
    const raw = task?.payload
    if (!raw) return null
    if (typeof raw === 'object') return raw
    if (typeof raw !== 'string') return null
    try {
      return JSON.parse(raw)
    } catch {
      return null
    }
  }

  private getTaskRunAt(task: any): number | null {
    const payload = this.parseTaskPayload(task)
    const runAt = payload?.__globalSchedule?.runAt
    if (typeof runAt !== 'string' || runAt.trim().length === 0) return null
    const timestamp = Date.parse(runAt)
    return Number.isNaN(timestamp) ? null : timestamp
  }

  private async enqueueScheduledTasks(
    description: string,
    payload: any,
    source: string | undefined,
    schedule: GlobalAgentTaskSchedule
  ): Promise<void> {
    const runTimes = this.computeScheduledRunTimes(schedule)
    if (runTimes.length === 0) {
      throw new Error('Schedule does not produce any valid run times.')
    }

    const now = Date.now()
    const repeatCount = Math.max(1, Math.min(500, Math.floor(schedule.repeatCount || 1)))
    const intervalMs = Math.max(1000, Math.floor(schedule.intervalMs || 1000))
    const normalizedWeekdays = this.normalizeWeekdays(schedule.allowedWeekdays)

    for (let i = 0; i < runTimes.length; i += 1) {
      const runAt = runTimes[i]
      const scheduleMeta: ScheduledTaskMeta = {
        runAt: runAt.toISOString(),
        sequence: i + 1,
        total: repeatCount,
        intervalMs,
        preset: schedule.preset,
        startDate: schedule.startDate ?? null,
        endDate: schedule.endDate ?? null,
        allowedWeekdays: normalizedWeekdays,
      }
      const taskPayload = this.buildScheduledTaskPayload(payload, scheduleMeta)
      const status = runAt.getTime() <= now ? 'pending' : 'scheduled'
      await localApi.post('/agent/tasks', {
        description,
        payload: taskPayload,
        source,
        status,
      })
    }
  }

  private async promoteDueScheduledTasks(nowMs: number): Promise<void> {
    const scheduledTasksResponse = await localApi.get<{ success: boolean; tasks: any[] }>('/agent/tasks?status=scheduled')
    const scheduledTasks = scheduledTasksResponse?.tasks || []
    if (scheduledTasks.length === 0) return

    for (const task of scheduledTasks) {
      const runAt = this.getTaskRunAt(task)
      if (runAt === null || runAt <= nowMs) {
        await localApi.patch(`/agent/tasks/${task.id}`, { status: 'pending' })
      }
    }
  }

  private async ensureSystemProjectAndSession(): Promise<void> {
    if (!this.userId) return

    const projects = await localApi.get<any[]>(`/app/projects?userId=${this.userId}`)
    let systemProject = projects.find(p => p.name === 'system')
    if (!systemProject) {
      systemProject = await localApi.post('/app/projects', {
        name: 'system',
        user_id: this.userId,
        storage_mode: 'local',
      })
    }
    this.systemProjectId = systemProject.id

    if (!this.state.conversationId) {
      const conversation = await localApi.post<{ id: string }>('/app/conversations', {
        user_id: this.userId,
        project_id: systemProject.id,
        title: this.settings?.agentName || 'Global Agent',
        cwd: this.getConfiguredWorkDirectory(),
        storage_mode: 'local',
      })

      const session = await localApi.post<{ session: { id: number } }>('/agent/session/start', {
        conversationId: conversation.id,
        rolloverReason: 'initial',
      })

      this.state.conversationId = conversation.id
      this.state.sessionId = session?.session?.id ?? null
      await localApi.put('/agent/state', {
        conversationId: this.state.conversationId,
        sessionId: this.state.sessionId,
      })
    }
  }

  private shouldRunHeartbeat(now: Date): boolean {
    const heartbeat = this.settings?.heartbeatTime
    if (!heartbeat) return false

    const [hoursStr, minutesStr] = heartbeat.split(':')
    const hours = Number(hoursStr)
    const minutes = Number(minutesStr)
    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return false

    const dateKey = now.toISOString().slice(0, 10)
    if (this.heartbeatLastDate === dateKey) return false

    if (now.getHours() !== hours || now.getMinutes() !== minutes) return false

    this.heartbeatLastDate = dateKey
    return true
  }

  private async runTick(): Promise<void> {
    if (!this.running || this.busy) return
    this.busy = true

    try {
      await this.refreshSettings()
      const now = new Date()

      // System project/session bootstrap is needed only when missing.
      // Avoid re-checking /app/projects on every tick.
      if (!this.systemProjectId || !this.state.conversationId) {
        await this.ensureSystemProjectAndSession()
      }

      await this.promoteDueScheduledTasks(now.getTime())

      const pendingTasksResponse = await localApi.get<{ success: boolean; tasks: any[] }>('/agent/tasks?status=pending')
      let pendingTasks = pendingTasksResponse?.tasks || []

      const maxQueue = 20
      if (pendingTasks.length > maxQueue) {
        const overflow = pendingTasks.slice(maxQueue)
        const summaryText = overflow.map(task => `- ${task.description}`).join('\\n')
        await localApi.post('/agent/tasks', {
          description: `Summarize and consolidate queued tasks:\\n${summaryText}`,
          source: 'system',
        })
        await Promise.all(
          overflow.map(task =>
            localApi.patch(`/agent/tasks/${task.id}`, {
              status: 'completed',
              error: 'summarized into overflow batch',
            })
          )
        )
        pendingTasks = pendingTasks.slice(0, maxQueue)
      }

      const heartbeatDue = this.shouldRunHeartbeat(now)

      if (pendingTasks.length === 0 && !heartbeatDue) {
        return
      }

      const hasActiveStream = Boolean(this.state.streamId) || Boolean(this.streamAbortController)
      if (hasActiveStream) {
        console.debug('[GlobalAgentLoop] Deferring queued task execution while stream is active')
        return
      }

      const task = pendingTasks[0] || {
        id: uuidv4(),
        description: 'Heartbeat check-in',
        source: 'system',
      }

      if (pendingTasks[0]) {
        await localApi.patch(`/agent/tasks/${task.id}`, { status: 'running' })
      }

      await this.maybeRolloverSession()
      await this.executeAgentTurn(task.description)

      if (pendingTasks[0]) {
        await localApi.patch(`/agent/tasks/${task.id}`, { status: 'completed' })
      }

      this.state.lastRunAt = new Date().toISOString()
      await localApi.put('/agent/state', { lastRunAt: this.state.lastRunAt })
      this.emit({ type: 'state', state: { ...this.state } })
    } finally {
      this.busy = false
    }
  }

  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4)
  }

  private async maybeRolloverSession(): Promise<void> {
    if (!this.state.conversationId || !this.settings?.modelContextLength) return

    const messages = await localApi.get<any[]>(`/app/conversations/${this.state.conversationId}/messages`)
    const totalText = messages.map(msg => msg.content || '').join('\\n')
    const estimatedTokens = this.estimateTokens(totalText)

    if (estimatedTokens < this.settings.modelContextLength * 0.8) return

    await this.summarizeAndStartNewSession(messages)
  }

  private async summarizeAndStartNewSession(messages: any[]): Promise<void> {
    if (!this.state.conversationId || !this.userId || !this.systemProjectId) return

    const summaryPrompt = `Summarize the key context from this session so the global agent can continue. Keep it concise and actionable.`
    const history = messages.map(msg => ({ role: msg.role, content: msg.content }))
    const response = await createStreamingRequest('/generate/ephemeral', this.accessToken, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [...history, { role: 'user', content: summaryPrompt }],
        model: this.settings?.model || 'google/gemini-3-flash-preview',
        maxTokens: 1024,
        temperature: 0.3,
      }),
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Global agent summary failed: HTTP ${response.status}: ${errorText}`)
    }

    const reader = response.body?.getReader()
    if (!reader) return

    const decoder = new TextDecoder()
    let sseBuffer = ''
    let summaryText = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = decoder.decode(value, { stream: true })
      sseBuffer += chunk
      const lines = sseBuffer.split('\\n')
      sseBuffer = lines.pop() || ''

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6)
        if (data === '[DONE]') continue
        try {
          const parsed = JSON.parse(data)
          if (parsed.text) summaryText += parsed.text
        } catch {
          if (data.trim()) summaryText += data
        }
      }
    }

    const summaryMessageId = uuidv4()
    await localApi.post('/sync/message', {
      id: summaryMessageId,
      conversation_id: this.state.conversationId,
      parent_id: messages.length > 0 ? messages[messages.length - 1].id : null,
      role: 'ex_agent',
      content: summaryText,
      plain_text_content: summaryText,
      model_name: this.settings?.model || 'unknown',
      ex_agent_session_id: this.state.sessionId ? String(this.state.sessionId) : null,
      ex_agent_type: 'persistent_agent_summary',
      created_at: new Date().toISOString(),
      user_id: this.userId,
    })

    await localApi.post('/agent/session/end', {
      sessionId: this.state.sessionId,
      summaryMessageId,
      rolloverReason: 'context_limit',
    })

    const newConversation = await localApi.post<{ id: string }>('/app/conversations', {
      user_id: this.userId,
      project_id: this.systemProjectId,
      title: this.settings?.agentName || 'Global Agent',
      cwd: this.getConfiguredWorkDirectory(),
      storage_mode: 'local',
    })

    const session = await localApi.post<{ session: { id: number } }>('/agent/session/start', {
      conversationId: newConversation.id,
      rolloverReason: 'context_limit',
    })

    this.state.conversationId = newConversation.id
    this.state.sessionId = session?.session?.id ?? null
    await localApi.put('/agent/state', {
      conversationId: this.state.conversationId,
      sessionId: this.state.sessionId,
    })

    // Invalidate cache so next render fetches new conversation
    if (this.queryClient) {
      this.queryClient.invalidateQueries({ queryKey: ['globalAgent', 'messages'] })
    }
  }

  private async executeAgentTurn(prompt: string): Promise<void> {
    if (!this.state.conversationId || !this.userId) return

    const conversationId = this.state.conversationId
    const messages = await localApi.get<any[]>(`/app/conversations/${conversationId}/messages`)

    const history = messages.map(msg => ({
      role: msg.role,
      content: msg.content,
      tool_call_id: msg.tool_call_id || undefined,
    }))

    const configuredWorkDirectory = this.getConfiguredWorkDirectory()
    const baseSystemPrompt = this.settings?.agentName
      ? `You are the global agent "${this.settings.agentName}". Execute the queued task carefully.`
      : 'You are the global agent. Execute the queued task carefully.'
    const systemPrompt = configuredWorkDirectory
      ? `${baseSystemPrompt}\n\nCurrent working directory: ${configuredWorkDirectory}`
      : baseSystemPrompt

    const toolAllowlist = this.settings?.toolAllowlist ?? null
    const baseTools = getToolsForAI()
    let allowedTools = baseTools.filter(tool => !toolAllowlist || toolAllowlist.includes(tool.name))

    // If custom tools are allowed, include the custom_tool_manager bridge.
    if (toolAllowlist) {
      const customTools = getAllTools().filter(tool => tool.isCustom && toolAllowlist.includes(tool.name))
      if (customTools.length > 0 && !allowedTools.some(tool => tool.name === 'custom_tool_manager')) {
        const customToolManager = getAllTools().find(tool => tool.name === 'custom_tool_manager')
        if (customToolManager) {
          allowedTools = [...allowedTools, customToolManager]
        }
      }
    }

    const streamId = uuidv4()
    this.state.streamId = streamId
    await localApi.put('/agent/state', { streamId })
    this.emit({ type: 'state', state: { ...this.state } })

    const userMessageId = uuidv4()
    const lastMessageId = messages.length > 0 ? messages[messages.length - 1].id : null
    const userMessage = {
      id: userMessageId,
      conversation_id: conversationId,
      parent_id: lastMessageId,
      role: 'user',
      content: prompt,
      plain_text_content: prompt,
      content_blocks: JSON.stringify([{ type: 'text', index: 0, content: prompt }]),
      model_name: this.settings?.model || 'unknown',
      ex_agent_session_id: this.state.sessionId ? String(this.state.sessionId) : null,
      ex_agent_type: 'persistent_agent',
      created_at: new Date().toISOString(),
      user_id: this.userId,
    }
    await localApi.post('/sync/message', userMessage)

    // Update React Query cache with persisted user message
    if (this.queryClient) {
      updateGlobalAgentMessageCache(this.queryClient, userMessage)
      // Clear optimistic message since real message is now persisted
      clearGlobalAgentOptimisticMessage(this.queryClient)
    }

    // Keep a single cursor so every persisted message links to the immediately
    // previous message. This guarantees a strictly linear global-agent session.
    let lineageCursorId = userMessageId
    let currentHistory = [...history, { role: 'user', content: prompt }]

    let aborted = false
    for (let turn = 0; turn < 3; turn += 1) {
      try {
        this.streamAbortController = new AbortController()
        const response = await createStreamingRequest('/generate/ephemeral', this.accessToken, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: currentHistory,
            model: this.settings?.model || 'google/gemini-3-flash-preview',
            maxTokens: this.settings?.modelContextLength ? Math.min(this.settings.modelContextLength, 16384) : 4096,
            temperature: 0.7,
            systemPrompt,
            tools: allowedTools.length > 0 ? allowedTools : undefined,
          }),
          signal: this.streamAbortController.signal,
        })

        if (!response.ok) {
          const errorText = await response.text()
          throw new Error(`Global agent generation failed: HTTP ${response.status}: ${errorText}`)
        }

        const reader = response.body?.getReader()
        if (!reader) {
          throw new Error('No response body from global agent')
        }

        const decoder = new TextDecoder()
        let sseBuffer = ''
        let turnText = ''
        let turnReasoning = ''
        const toolCalls: any[] = []
        const serverToolResults: any[] = [] // Track server-executed tools (e.g., brave_search)

        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          const chunk = decoder.decode(value, { stream: true })
          sseBuffer += chunk
          const lines = sseBuffer.split('\n')
          sseBuffer = lines.pop() || ''

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue
            const data = line.slice(6)
            if (data === '[DONE]') continue
            try {
              const parsed = JSON.parse(data)
              if (parsed.text) {
                turnText += parsed.text
                this.emit({ type: 'stream', data: { streamId, delta: parsed.text, kind: 'text' } })
                // Update React Query cache buffer
                if (this.queryClient) {
                  const currentBuffer = getGlobalAgentStreamBuffer(this.queryClient)
                  updateGlobalAgentStreamBuffer(this.queryClient, currentBuffer + parsed.text)
                }
              } else if (parsed.reasoning) {
                turnReasoning += parsed.reasoning
                this.emit({ type: 'stream', data: { streamId, delta: parsed.reasoning, kind: 'reasoning' } })
              } else if (parsed.toolCall) {
                toolCalls.push(parsed.toolCall)
                this.emit({ type: 'stream', data: { streamId, delta: '', kind: 'tool_call' } })
              } else if (parsed.toolResult) {
                // Server executed a tool (e.g., brave_search) and sent back the result
                serverToolResults.push(parsed.toolResult)
                this.emit({
                  type: 'stream',
                  data: { streamId, delta: JSON.stringify(parsed.toolResult), kind: 'tool_result' },
                })
              }
            } catch {
              if (data.trim()) {
                turnText += data
                this.emit({ type: 'stream', data: { streamId, delta: data, kind: 'text' } })
                // Update React Query cache buffer
                if (this.queryClient) {
                  const currentBuffer = getGlobalAgentStreamBuffer(this.queryClient)
                  updateGlobalAgentStreamBuffer(this.queryClient, currentBuffer + data)
                }
              }
            }
          }
        }

        const assistantMessageId = uuidv4()
        const contentBlocks: any[] = []
        if (turnText) {
          contentBlocks.push({ type: 'text', index: 0, content: turnText })
        }
        if (toolCalls.length > 0) {
          for (const toolCall of toolCalls) {
            contentBlocks.push({
              type: 'tool_use',
              index: contentBlocks.length,
              id: toolCall.id,
              name: toolCall.name,
              input: toolCall.arguments ?? {},
            })
          }
        }

        const assistantParentId = lineageCursorId
        const assistantMessage = {
          id: assistantMessageId,
          conversation_id: conversationId,
          parent_id: assistantParentId,
          role: 'ex_agent',
          content: turnText,
          plain_text_content: turnText,
          thinking_block: turnReasoning || null,
          tool_calls: toolCalls.length > 0 ? JSON.stringify(toolCalls) : null,
          content_blocks: contentBlocks.length > 0 ? JSON.stringify(contentBlocks) : null,
          model_name: this.settings?.model || 'unknown',
          ex_agent_session_id: this.state.sessionId ? String(this.state.sessionId) : null,
          ex_agent_type: 'persistent_agent',
          created_at: new Date().toISOString(),
          user_id: this.userId,
        }
        await localApi.post('/sync/message', assistantMessage)
        lineageCursorId = assistantMessageId

        // Update React Query cache immediately
        if (this.queryClient) {
          updateGlobalAgentMessageCache(this.queryClient, assistantMessage)
          // Clear stream buffer after short delay to ensure UI picks up the persisted message
          setTimeout(() => clearGlobalAgentStreamBuffer(this.queryClient), 150)
        }

        this.emit({
          type: 'message',
          data: { messageId: assistantMessageId, role: 'ex_agent', content: turnText },
        })

        // If no tool calls and no server tool results, we're done
        if (toolCalls.length === 0 && serverToolResults.length === 0) break

        const toolResults: { role: 'tool'; tool_call_id: string; content: string }[] = []

        // First, handle server-executed tools (e.g., brave_search)
        // These tools were already executed by the server and sent back as toolResult events
        const serverToolCallIds = new Set(serverToolResults.map((tr: any) => tr.tool_use_id || tr.id))

        for (const serverToolResult of serverToolResults) {
          const toolCallId = serverToolResult.tool_use_id || serverToolResult.id
          const toolContent =
            typeof serverToolResult.content === 'string'
              ? serverToolResult.content
              : JSON.stringify(serverToolResult.content)

          // Persist server tool result message to SQLite
          const toolMessageId = uuidv4()
          const toolMessage = {
            id: toolMessageId,
            conversation_id: conversationId,
            parent_id: lineageCursorId,
            role: 'tool',
            content: toolContent,
            plain_text_content: toolContent,
            tool_call_id: toolCallId,
            content_blocks: JSON.stringify([
              {
                type: 'tool_result',
                index: 0,
                tool_use_id: toolCallId,
                content: toolContent,
                is_error: serverToolResult.is_error || false,
              },
            ]),
            model_name: this.settings?.model || 'unknown',
            ex_agent_session_id: this.state.sessionId ? String(this.state.sessionId) : null,
            ex_agent_type: 'persistent_agent',
            created_at: new Date().toISOString(),
            user_id: this.userId,
          }
          await localApi.post('/sync/message', toolMessage)
          lineageCursorId = toolMessageId

          // Update React Query cache with tool message
          if (this.queryClient) {
            updateGlobalAgentMessageCache(this.queryClient, toolMessage)
          }

          contentBlocks.push({
            type: 'tool_result',
            index: contentBlocks.length,
            tool_use_id: toolCallId,
            content: toolContent,
            is_error: serverToolResult.is_error || false,
          })

          toolResults.push({ role: 'tool', tool_call_id: toolCallId, content: toolContent })
        }

        // Then, execute remaining tools locally (tools not executed by server)
        for (const toolCall of toolCalls) {
          // Skip if this tool was already executed by the server
          if (serverToolCallIds.has(toolCall.id)) {
            continue
          }

          const result = await executeLocalTool(toolCall, configuredWorkDirectory, 'execute', {
            conversationId,
            messageId: assistantMessageId,
            streamId,
            accessToken: this.accessToken,
            dispatch: this.dispatch,
            getState: this.reduxGetState,
          })

          this.emit({
            type: 'stream',
            data: { streamId, delta: JSON.stringify(result), kind: 'tool_result' },
          })

          const toolMessageId = uuidv4()
          const toolContent = typeof result === 'string' ? result : JSON.stringify(result)
          const toolMessage = {
            id: toolMessageId,
            conversation_id: conversationId,
            parent_id: lineageCursorId,
            role: 'tool',
            content: toolContent,
            plain_text_content: toolContent,
            tool_call_id: toolCall.id,
            content_blocks: JSON.stringify([
              {
                type: 'tool_result',
                index: 0,
                tool_use_id: toolCall.id,
                content: toolContent,
                is_error: false,
              },
            ]),
            model_name: this.settings?.model || 'unknown',
            ex_agent_session_id: this.state.sessionId ? String(this.state.sessionId) : null,
            ex_agent_type: 'persistent_agent',
            created_at: new Date().toISOString(),
            user_id: this.userId,
          }

          await localApi.post('/sync/message', toolMessage)
          lineageCursorId = toolMessageId

          // Update React Query cache with tool message
          if (this.queryClient) {
            updateGlobalAgentMessageCache(this.queryClient, toolMessage)
          }

          contentBlocks.push({
            type: 'tool_result',
            index: contentBlocks.length,
            tool_use_id: toolCall.id,
            content: toolContent,
            is_error: false,
          })

          toolResults.push({ role: 'tool', tool_call_id: toolCall.id, content: toolContent })
        }

        currentHistory = [...currentHistory, { role: 'assistant', content: turnText }, ...toolResults]

        await localApi.post('/sync/message', {
          id: assistantMessageId,
          conversation_id: conversationId,
          parent_id: assistantParentId,
          role: 'ex_agent',
          content: turnText,
          plain_text_content: turnText,
          thinking_block: turnReasoning || null,
          tool_calls: toolCalls.length > 0 ? JSON.stringify(toolCalls) : null,
          content_blocks: contentBlocks.length > 0 ? JSON.stringify(contentBlocks) : null,
          model_name: this.settings?.model || 'unknown',
          ex_agent_session_id: this.state.sessionId ? String(this.state.sessionId) : null,
          ex_agent_type: 'persistent_agent',
          created_at: new Date().toISOString(),
          user_id: this.userId,
        })
      } catch (error) {
        const isAbort =
          (error instanceof DOMException && error.name === 'AbortError') ||
          (error instanceof Error && error.message.toLowerCase().includes('aborted'))

        if (isAbort) {
          if (this.queryClient) {
            clearGlobalAgentStreamBuffer(this.queryClient)
          }
          aborted = true
          break
        }
        throw error
      } finally {
        this.streamAbortController = null
      }
    }

    if (this.state.streamId) {
      this.state.streamId = null
      try {
        await localApi.put('/agent/state', { streamId: null })
      } catch (error) {
        console.warn('[GlobalAgentLoop] Failed to clear streamId:', error)
      }
      this.emit({ type: 'state', state: { ...this.state } })
    }

    if (aborted) {
      return
    }
  }
}

export const globalAgentLoop = GlobalAgentLoop.getInstance()
