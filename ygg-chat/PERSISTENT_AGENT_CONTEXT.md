# Persistent Background Agent - Architecture Context & Design Document

> **Historical — cloud parts removed.** Graviton is now fully local (2026-11): there is no Supabase/Railway
> account or sync, cloud storage mode, hosted OpenRouter provider, Stripe billing or web product. Sections that
> describe those are kept for history only. Current behaviour: `ygg-chat/docs/agent_context/AGENT.md`.

**Date:** 2026-01-28
**Project:** ygg-chat (Electron AI Agentic App)
**Goal:** Create a persistent background agent that operates continuously in a loop, inspired by moltbot's agent loop pattern

---

## Executive Summary

This document provides comprehensive context for implementing a **persistent background agent** system in ygg-chat. The agent will run continuously in the background, executing tasks autonomously in local mode (Electron app only) within a dedicated "system" project and conversation.

**Key Requirements:**
- Persistent agent runs continuously in background (pausable by user)
- Operates in local mode only (Electron + local SQLite)
- Uses single global stream for all agent output
- Creates/uses system project ("system") with timestamped conversations
- No parallel streams initially (single global agent loop)
- Inspired by moltbot concepts: agent loop, context, memory, queue

---

## Current Architecture Overview

### 1. Tech Stack

**Frontend:**
- React 18 + TypeScript
- Redux Toolkit (state management)
- React Query (server state caching)
- Vite (build tool)

**Backend:**
- Express.js server (Railway cloud deployment)
- Supabase PostgreSQL (cloud storage)
- SQLite3 (local storage in Electron)

**Desktop:**
- Electron (main process + renderer)
- Embedded Node.js server on port 3002 (localServer.ts)
- Dual-sync architecture (local SQLite ↔ cloud PostgreSQL)

### 2. Storage Architecture

**Dual Storage Modes:**
- **Cloud mode:** Data stored in Supabase PostgreSQL, synced to local SQLite cache
- **Local mode:** Data stored only in local SQLite (Electron only)

Each entity (Project, Conversation, Message) has `storage_mode` field:
- `'cloud'`: Stored in Supabase, synced to local cache
- `'local'`: Stored only in local SQLite (no cloud sync)

**Key Constraint:** Agent must operate exclusively in local mode.

### 3. Data Model

#### Projects
```typescript
interface Project {
  id: string
  name: string
  user_id: string
  context?: string
  system_prompt?: string
  storage_mode: 'cloud' | 'local'
  created_at: string
  updated_at: string
}
```

#### Conversations
```typescript
interface Conversation {
  id: string
  project_id?: string
  user_id: string
  title?: string
  model_name: string
  system_prompt?: string
  conversation_context?: string
  research_note?: string
  cwd?: string
  storage_mode: 'cloud' | 'local'
  created_at: string
  updated_at: string
}
```

#### Messages
```typescript
interface Message {
  id: string
  conversation_id: string
  parent_id?: string
  children_ids: string[]
  role: 'user' | 'assistant' | 'system' | 'ex_agent' | 'tool'
  content: string
  content_plain_text: string
  thinking_block?: string
  tool_calls?: ToolCall[]
  tool_call_id?: string
  model_name: string
  note?: string
  ex_agent_session_id?: string  // For tracking subagent sessions
  ex_agent_type?: string         // 'subagent' or 'persistent_agent'
  content_blocks?: ContentBlock[]
  created_at: string
  partial: boolean
  artifacts?: string[]
  pastedContext?: any[]
}
```

**Message Tree Structure:**
- Messages form a tree via `parent_id` and `children_ids`
- Supports branching conversations
- Client builds tree using `buildTreeFromMessages()` helper

### 4. Message Flow Architecture

#### Current Chat Flow (Chat.tsx + chatActions.ts)

**User Sends Message:**
1. User types in `<Chat>` component
2. Redux: `sendMessage` thunk dispatched
3. Thunk flow:
   - Generate `streamId` (UUID or provided)
   - Dispatch `sendingStarted` → creates stream state in Redux
   - Determine provider (OpenRouter, Gemini, LM Studio, etc.)
   - Call streaming endpoint (cloud or local based on storage_mode)
   - Read SSE stream chunks
   - Dispatch `streamChunkReceived` for each chunk
   - Update Redux streaming buffer incrementally
   - On completion: dispatch `streamCompleted`

**Streaming State (Redux):**
```typescript
interface StreamState {
  active: boolean
  buffer: string               // Accumulated text
  thinkingBuffer: string      // Reasoning blocks
  toolCalls: ToolCall[]       // Pending tool calls
  events: StreamEvent[]       // Sequential log (text, reasoning, tool_call, tool_result)
  messageId: string | null    // Final message ID
  streamingMessageId: string | null
  error: string | null
  finished: boolean
  lineage: StreamLineage      // Parent tracking
  createdAt: string
  streamType: StreamType      // 'primary' | 'subagent' | 'tool' | 'branch'
}
```

**Multi-Stream Support:**
```typescript
streaming: {
  activeIds: string[]        // All active stream IDs
  byId: Record<string, StreamState>
  primaryStreamId: string | null
  lastCompletedId: string | null
}
```

**Stream Types:**
- `primary`: Main chat stream (user interaction)
- `subagent`: Spawned by subagent tool
- `tool`: Tool-specific background streams
- `branch`: Branching/regeneration streams

**Critical Pattern:** Use `DEFAULT_STREAM_ID` for backward compatibility. New code should generate explicit `streamId` values.

#### Tool Execution During Streaming

**Multi-Turn Agentic Loop (chatActions.ts: sendMessage):**
```typescript
while (continueTurn && turnCount < MAX_TURNS) {
  // 1. Call LLM with conversation history
  const response = await createStreamingRequest(...)

  // 2. Parse SSE chunks (text, reasoning, tool_calls)
  // Dispatch streamChunkReceived for each chunk

  // 3. If tool_calls present:
  for (const toolCall of toolCalls) {
    // Execute tool (with permission check)
    const result = await executeToolWithPermissionCheck(...)

    // Append tool result to history
    conversationHistory.push({
      role: 'tool',
      tool_call_id: toolCall.id,
      content: result
    })
  }

  // 4. Continue to next turn if tools were executed
  continueTurn = toolCalls.length > 0
}
```

**Tool Permission System:**
- `toolAutoApprove` Redux state (boolean)
- If disabled: show permission dialog via `toolPermissionRequested` action
- If enabled: execute immediately via `executeLocalTool()`

**Tool Execution Context:**
```typescript
executeLocalTool(toolCall, rootPath, operationMode, {
  conversationId,
  messageId,
  streamId,     // Links tool execution to stream
  priority,
  timeoutMs,
  accessToken,
  dispatch,     // For subagent access
  getState      // For subagent access
})
```

### 5. Subagent Implementation (Current)

**Subagent Tool Definition:**
- Name: `'subagent'`
- Allows spawning independent agentic sessions
- Has own tool access (configurable via `orchestratorMode`)
- Multi-turn execution with quota enforcement

**Execution Flow (chatActions.ts: executeSubagentCall):**
```typescript
// 1. Determine tool access
const subagentTools = getSubagentToolDefinitions(
  orchestratorMode,
  requestedTools
)

// 2. Generate session ID
const subagentSessionId = uuidv4()

// 3. Persist prompt message to local storage
await localApi.post('/sync/message', {
  id: promptMessageId,
  conversation_id,
  parent_id: parentMessageId,
  role: 'ex_agent',
  content: prompt,
  ex_agent_type: 'subagent',
  ex_agent_session_id: subagentSessionId
})

// 4. Agentic loop
for (let turn = 0; turn < maxTurns && shouldContinue; turn++) {
  // Call ephemeral endpoint with tools
  const response = await createStreamingRequest('/generate/ephemeral', ...)

  // Parse response (text, reasoning, tool_calls)

  // Execute client tools with permission check
  for (const toolCall of clientToolCalls) {
    const result = await executeToolWithPermissionCheck(...)
    toolResults.push({ tool_use_id: toolCall.id, content: result })
  }

  // Persist assistant message with tool calls/results
  await localApi.post('/sync/message', assistantMessage)

  // Add to conversation history for next turn
  conversationHistory.push(assistantMsg, ...toolResults)
}

// 5. Return formatted result
return `## Subagent Response (session: ${sessionId.slice(0,8)})\n\n${finalResponse}\n\n---\nTurns: ${turnsUsed}/${maxTurns} | Tool calls: ${totalToolCallsUsed}/${maxToolCalls}`
```

**Key Subagent Features:**
- Persists all messages to local SQLite with `ex_agent_type: 'subagent'`
- Tracks session via `ex_agent_session_id`
- Tool quota enforcement (`maxToolCalls`)
- Turn limit enforcement (`maxTurns`)
- Can inherit `toolAutoApprove` from parent
- Supports abort via stream cancellation

### 6. Background Job System (ToolOrchestrator)

**Location:** `/client/ygg-chat-r/electron/tools/orchestrator/`

**Architecture:**
- Singleton service (`toolOrchestrator`) in local server
- Manages background job queue with priority ordering
- Persists jobs to SQLite for crash recovery
- WebSocket-based real-time updates

**Job Lifecycle:**
```
pending → running → completed/failed/cancelled
```

**Job Structure:**
```typescript
interface Job {
  id: string
  toolName: string
  args: Record<string, any>
  status: JobStatus
  priority: JobPriority
  rootPath: string | null
  operationMode: 'plan' | 'execute'
  timeoutMs: number
  retries: number
  retriesRemaining: number
  conversationId: string | null
  messageId: string | null
  streamId: string | null
  createdAt: string
  startedAt: string | null
  completedAt: string | null
  result: any | null
  error: string | null
  progress: number
  progressMessage: string | null
}
```

**Client Interface (ToolJobManager):**
```typescript
// Submit job
const job = await toolJobManager.submitJob(
  'read_file',
  { path: '/path/to/file' },
  {
    priority: 'normal',
    conversationId,
    messageId,
    streamId
  }
)

// Query jobs
const runningJobs = toolJobManager.getRunningJobs()
const jobsByStatus = toolJobManager.getJobsByStatus(['pending', 'running'])

// Subscribe to events
toolJobManager.onJobEvent((event: JobEvent) => {
  console.log('Job event:', event)
})
```

**WebSocket Events:**
- `job_created`
- `job_started`
- `job_progress`
- `job_completed`
- `job_failed`
- `job_cancelled`

### 7. Background Worker Pattern (OpenRouter Reconciliation)

**Location:** `/server/src/workers/openrouter-reconciliation.ts`

**Pattern:**
```typescript
let isRunning = false
let intervalHandle: NodeJS.Timeout | null = null

async function runReconciliationBatch(): Promise<void> {
  if (isRunning) return
  isRunning = true

  try {
    // 1. Fetch pending work from database
    const pendingWork = await fetchPendingWork()

    // 2. Process batch
    for (const item of pendingWork) {
      await processItem(item)
    }
  } finally {
    isRunning = false
  }
}

export function startWorker(): void {
  if (intervalHandle) return

  // Run immediately
  runReconciliationBatch()

  // Set up polling interval
  intervalHandle = setInterval(
    runReconciliationBatch,
    INTERVAL_MS
  )
}

export function stopWorker(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle)
    intervalHandle = null
  }
}
```

**Key Characteristics:**
- Simple polling approach (not event-driven)
- Guard against concurrent execution (`isRunning` flag)
- Self-contained batch processing
- Database-backed state
- Can be started/stopped on demand

---

## API Patterns

### 1. Project Creation

```typescript
// Client thunk
const project = await dispatch(createProject({
  name: 'system',
  storageMode: 'local'
})).unwrap()

// Local API endpoint
const project = await localApi.post<Project>('/local/projects', {
  user_id: auth.userId,
  name: 'system',
  context: null,
  system_prompt: null,
  storage_mode: 'local'
})
```

### 2. Conversation Creation

```typescript
// Client thunk
const conversation = await dispatch(createConversation({
  title: `system - ${new Date().toISOString()}`,
  projectId: systemProject.id,
  storageMode: 'local'
})).unwrap()

// Local API endpoint
const conversation = await localApi.post<Conversation>('/local/conversations', {
  user_id: auth.userId,
  title: title || null,
  project_id: projectId,
  system_prompt: null,
  conversation_context: null,
  storage_mode: 'local'
})
```

### 3. Message Persistence (Local Mode)

```typescript
await localApi.post('/sync/message', {
  id: messageId,
  conversation_id: conversationId,
  parent_id: parentId,
  role: 'ex_agent',
  content: messageContent,
  ex_agent_type: 'persistent_agent',
  ex_agent_session_id: agentSessionId,
  created_at: new Date().toISOString()
})
```

---

## Persistent Agent Design

### 1. Core Components

#### AgentLoop (Client-side Service)

**Location:** `/client/ygg-chat-r/src/services/AgentLoop.ts` (new file)

**Responsibilities:**
- Manage agent lifecycle (start, pause, resume, stop)
- Maintain agent state in Redux
- Coordinate with streaming system via single global stream
- Persist state to localStorage + SQLite for recovery
- Execute agentic turns with tool calling
- Manage task queue

**Key Methods:**
```typescript
class AgentLoop {
  private loopTimer: NodeJS.Timeout | null
  private state: AgentLoopState

  async initialize(): Promise<void>
  async start(): Promise<void>
  pause(): void
  resume(): void
  stop(): void

  private async executeAgenticTurn(): Promise<void>
  private async processTaskQueue(): Promise<void>
  private saveState(): void
  private loadState(): AgentLoopState | null
}
```

#### Redux Integration

**New Slice:** `/client/ygg-chat-r/src/features/agentLoop/agentLoopSlice.ts`

```typescript
interface AgentLoopState {
  // Lifecycle
  status: 'idle' | 'initializing' | 'running' | 'paused' | 'stopping' | 'error'
  sessionId: string | null

  // Context
  systemProjectId: string | null
  systemConversationId: string | null
  currentStreamId: string | null

  // Task Management
  taskQueue: AgentTask[]
  currentTask: AgentTask | null

  // History
  turnCount: number
  totalToolCallsUsed: number
  lastExecutionAt: string | null

  // Config
  config: {
    turnIntervalMs: number
    maxTurnsPerSession: number
    model: string
    systemPrompt: string
  }

  // Error tracking
  error: string | null
}

interface AgentTask {
  id: string
  description: string
  priority: 'low' | 'normal' | 'high' | 'critical'
  status: 'pending' | 'in_progress' | 'completed' | 'failed'
  createdAt: string
  completedAt?: string
}
```

**Actions:**
```typescript
// Lifecycle actions
agentLoopActions.initializeRequested()
agentLoopActions.initialized({ systemProjectId, systemConversationId })
agentLoopActions.startRequested()
agentLoopActions.started({ sessionId, streamId })
agentLoopActions.pauseRequested()
agentLoopActions.paused()
agentLoopActions.resumeRequested()
agentLoopActions.resumed()
agentLoopActions.stopRequested()
agentLoopActions.stopped()

// Task actions
agentLoopActions.taskAdded(task)
agentLoopActions.taskStarted(taskId)
agentLoopActions.taskCompleted(taskId)
agentLoopActions.taskFailed({ taskId, error })

// Turn tracking
agentLoopActions.turnStarted()
agentLoopActions.turnCompleted({ toolCallsUsed })
agentLoopActions.errorOccurred(error)
```

#### Background Worker (Local Server)

**Location:** `/client/ygg-chat-r/electron/workers/agentLoop.ts` (new file)

**Pattern:** Similar to openrouter-reconciliation worker

```typescript
let isRunning = false
let intervalHandle: NodeJS.Timeout | null = null
let agentLoopService: AgentLoopService | null = null

async function executeAgenticTurn(): Promise<void> {
  if (isRunning) return
  isRunning = true

  try {
    // 1. Check if agent is active (query local DB)
    const agentState = await loadAgentState()
    if (agentState.status !== 'running') return

    // 2. Execute turn
    await agentLoopService?.executeTurn()

  } catch (error) {
    console.error('[AgentLoopWorker] Error:', error)
    await agentLoopService?.handleError(error)
  } finally {
    isRunning = false
  }
}

export function startAgentLoopWorker(): void {
  if (intervalHandle) return

  console.log('[AgentLoopWorker] Starting persistent agent worker')

  // Initialize service
  agentLoopService = new AgentLoopService()

  // Run immediately
  executeAgenticTurn()

  // Set up polling interval (default: 30 seconds)
  intervalHandle = setInterval(
    executeAgenticTurn,
    AGENT_TURN_INTERVAL_MS
  )
}

export function stopAgentLoopWorker(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle)
    intervalHandle = null
  }
  agentLoopService = null
}
```

### 2. Implementation Flow

#### Phase 1: Initialization

**When app launches (if agent enabled):**

1. Check for system project
   ```typescript
   const systemProject = await findOrCreateSystemProject()
   ```

2. Check for active system conversation
   ```typescript
   const conversation = await findOrCreateSystemConversation(systemProject.id)
   ```

3. Load agent state from localStorage + SQLite
   ```typescript
   const savedState = loadAgentState()
   if (savedState?.status === 'running') {
     // Resume agent
     await agentLoop.resume()
   }
   ```

4. Initialize Redux state
   ```typescript
   dispatch(agentLoopActions.initialized({
     systemProjectId,
     systemConversationId,
     savedState
   }))
   ```

#### Phase 2: Agent Start

**User clicks "Start Agent" button:**

1. Dispatch start action
   ```typescript
   dispatch(startAgent()).unwrap()
   ```

2. Generate session ID
   ```typescript
   const sessionId = uuidv4()
   const streamId = generateStreamId('primary')
   ```

3. Create initial agent message
   ```typescript
   const initialMessage = {
     id: uuidv4(),
     conversation_id: systemConversationId,
     parent_id: lastMessageId,
     role: 'ex_agent',
     content: 'Persistent agent session started.',
     ex_agent_type: 'persistent_agent',
     ex_agent_session_id: sessionId,
     created_at: new Date().toISOString()
   }

   await localApi.post('/sync/message', initialMessage)
   ```

4. Start streaming state
   ```typescript
   dispatch(chatSliceActions.sendingStarted({
     streamId,
     streamType: 'primary',
     lineage: { rootMessageId: initialMessage.id }
   }))
   ```

5. Save state to localStorage + SQLite
   ```typescript
   saveAgentState({
     status: 'running',
     sessionId,
     streamId,
     systemConversationId
   })
   ```

6. Trigger first turn
   ```typescript
   await agentLoop.executeAgenticTurn()
   ```

#### Phase 3: Agentic Turn Execution

**Every turn interval (or when task available):**

```typescript
async executeAgenticTurn(): Promise<void> {
  // 1. Check if agent should run
  const state = this.getState()
  if (state.agentLoop.status !== 'running') return

  // 2. Get current task or generate autonomous goal
  let currentTask = state.agentLoop.currentTask
  if (!currentTask) {
    currentTask = await this.generateAutonomousTask()
  }

  // 3. Build conversation history
  const messages = await this.fetchConversationMessages()
  const conversationHistory = this.buildHistory(messages)

  // 4. Build prompt
  const prompt = this.buildAgentPrompt(currentTask, conversationHistory)

  // 5. Call LLM with streaming
  const response = await createStreamingRequest('/generate/ephemeral', accessToken, {
    messages: [{ role: 'user', content: prompt }],
    model: state.agentLoop.config.model,
    systemPrompt: state.agentLoop.config.systemPrompt,
    tools: getToolsForAI()  // All available tools
  })

  // 6. Parse SSE stream
  let turnText = ''
  let turnReasoning = ''
  const turnToolCalls: ToolCall[] = []

  for await (const chunk of parseSSEStream(response)) {
    if (chunk.type === 'text') {
      turnText += chunk.text
      dispatch(chatSliceActions.streamChunkReceived({
        streamId: state.agentLoop.currentStreamId,
        chunk: { type: 'chunk', part: 'text', delta: chunk.text }
      }))
    } else if (chunk.type === 'reasoning') {
      turnReasoning += chunk.reasoning
      dispatch(chatSliceActions.streamChunkReceived({
        streamId: state.agentLoop.currentStreamId,
        chunk: { type: 'chunk', part: 'reasoning', delta: chunk.reasoning }
      }))
    } else if (chunk.type === 'tool_call') {
      turnToolCalls.push(chunk.toolCall)
      dispatch(chatSliceActions.streamChunkReceived({
        streamId: state.agentLoop.currentStreamId,
        chunk: { type: 'chunk', part: 'tool_call', toolCall: chunk.toolCall }
      }))
    }
  }

  // 7. Create assistant message
  const assistantMessage = {
    id: uuidv4(),
    conversation_id: state.agentLoop.systemConversationId,
    parent_id: messages[messages.length - 1].id,
    role: 'ex_agent',
    content: turnText,
    thinking_block: turnReasoning,
    tool_calls: turnToolCalls,
    ex_agent_type: 'persistent_agent',
    ex_agent_session_id: state.agentLoop.sessionId,
    created_at: new Date().toISOString()
  }

  await localApi.post('/sync/message', assistantMessage)
  dispatch(chatSliceActions.messageAdded(assistantMessage))

  // 8. Execute tool calls (if any)
  if (turnToolCalls.length > 0) {
    for (const toolCall of turnToolCalls) {
      try {
        const result = await executeLocalTool(toolCall, rootPath, operationMode, {
          conversationId: state.agentLoop.systemConversationId,
          messageId: assistantMessage.id,
          streamId: state.agentLoop.currentStreamId,
          accessToken
        })

        // Dispatch tool result chunk
        dispatch(chatSliceActions.streamChunkReceived({
          streamId: state.agentLoop.currentStreamId,
          chunk: {
            type: 'chunk',
            part: 'tool_result',
            toolResult: {
              tool_use_id: toolCall.id,
              content: result,
              is_error: false
            }
          }
        }))

        // Create tool result message
        const toolResultMessage = createToolResultMessage(
          state.agentLoop.systemConversationId,
          assistantMessage.id,
          toolCall.id,
          result
        )

        await localApi.post('/sync/message', toolResultMessage)
        dispatch(chatSliceActions.messageAdded(toolResultMessage))

      } catch (error) {
        console.error('[AgentLoop] Tool execution failed:', error)
        // Persist error as tool result
        const errorResult = createToolResultMessage(
          state.agentLoop.systemConversationId,
          assistantMessage.id,
          toolCall.id,
          `Error: ${error.message}`
        )
        await localApi.post('/sync/message', errorResult)
      }
    }
  }

  // 9. Update turn count
  dispatch(agentLoopActions.turnCompleted({
    toolCallsUsed: turnToolCalls.length
  }))

  // 10. Save state
  this.saveState()
}
```

#### Phase 4: Pause/Resume

**Pause:**
```typescript
pause(): void {
  const state = this.getState()
  if (state.agentLoop.status !== 'running') return

  // Stop stream if active
  if (state.agentLoop.currentStreamId) {
    dispatch(chatSliceActions.streamingAborted({
      streamId: state.agentLoop.currentStreamId,
      error: 'Agent paused by user'
    }))
  }

  // Update state
  dispatch(agentLoopActions.paused())

  // Save to persistence
  this.saveState()
}
```

**Resume:**
```typescript
async resume(): Promise<void> {
  const state = this.getState()
  if (state.agentLoop.status !== 'paused') return

  // Generate new stream
  const streamId = generateStreamId('primary')

  // Resume state
  dispatch(agentLoopActions.resumed())

  // Start new stream
  dispatch(chatSliceActions.sendingStarted({
    streamId,
    streamType: 'primary'
  }))

  // Save state
  this.saveState()

  // Trigger next turn
  await this.executeAgenticTurn()
}
```

### 3. UI Integration

#### Agent Control Panel Component

**Location:** `/client/ygg-chat-r/src/components/AgentControl/AgentControl.tsx`

```typescript
export function AgentControl() {
  const dispatch = useAppDispatch()
  const agentState = useAppSelector(state => state.agentLoop)

  const handleStart = async () => {
    try {
      await dispatch(startAgent()).unwrap()
    } catch (error) {
      console.error('Failed to start agent:', error)
    }
  }

  const handlePause = () => {
    dispatch(pauseAgent())
  }

  const handleResume = () => {
    dispatch(resumeAgent())
  }

  const handleStop = () => {
    dispatch(stopAgent())
  }

  return (
    <div className="agent-control-panel">
      <div className="status">
        Status: {agentState.status}
      </div>

      {agentState.status === 'idle' && (
        <button onClick={handleStart}>Start Agent</button>
      )}

      {agentState.status === 'running' && (
        <button onClick={handlePause}>Pause</button>
      )}

      {agentState.status === 'paused' && (
        <>
          <button onClick={handleResume}>Resume</button>
          <button onClick={handleStop}>Stop</button>
        </>
      )}

      <div className="stats">
        <div>Turns: {agentState.turnCount}</div>
        <div>Tool Calls: {agentState.totalToolCallsUsed}</div>
      </div>

      {agentState.currentTask && (
        <div className="current-task">
          <strong>Current Task:</strong>
          <p>{agentState.currentTask.description}</p>
        </div>
      )}

      {agentState.taskQueue.length > 0 && (
        <div className="task-queue">
          <strong>Task Queue ({agentState.taskQueue.length}):</strong>
          <ul>
            {agentState.taskQueue.map(task => (
              <li key={task.id}>{task.description}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
```

#### Global Stream View

**Integration with Chat.tsx:**

The persistent agent uses the same streaming visualization as regular chats. When the system conversation is open in Chat.tsx, the agent's stream appears in the message thread like normal assistant responses.

**Key:** Agent messages are persisted with `ex_agent_type: 'persistent_agent'` so they can be visually distinguished (optional styling).

### 4. Persistence & Recovery

#### State Persistence

**localStorage:**
```typescript
const AGENT_STATE_KEY = 'ygg_agent_loop_state'

function saveAgentState(state: AgentLoopState): void {
  localStorage.setItem(AGENT_STATE_KEY, JSON.stringify({
    status: state.status,
    sessionId: state.sessionId,
    systemProjectId: state.systemProjectId,
    systemConversationId: state.systemConversationId,
    currentStreamId: state.currentStreamId,
    turnCount: state.turnCount,
    totalToolCallsUsed: state.totalToolCallsUsed,
    lastExecutionAt: state.lastExecutionAt,
    config: state.config
  }))
}

function loadAgentState(): AgentLoopState | null {
  const raw = localStorage.getItem(AGENT_STATE_KEY)
  if (!raw) return null

  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}
```

**SQLite (via local server):**

Create dedicated table for agent state:
```sql
CREATE TABLE IF NOT EXISTS agent_loop_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),  -- Singleton row
  status TEXT NOT NULL,
  session_id TEXT,
  system_project_id TEXT,
  system_conversation_id TEXT,
  current_stream_id TEXT,
  turn_count INTEGER DEFAULT 0,
  total_tool_calls_used INTEGER DEFAULT 0,
  last_execution_at TEXT,
  config TEXT NOT NULL,  -- JSON
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
)
```

**Crash Recovery:**

On app startup:
```typescript
async function initializeAgentLoop(): Promise<void> {
  // 1. Load state from localStorage
  const localState = loadAgentState()

  // 2. Load state from SQLite
  const dbState = await localApi.get('/local/agent-state')

  // 3. Merge (prioritize most recent)
  const state = mergeAgentStates(localState, dbState)

  // 4. If agent was running, resume
  if (state?.status === 'running') {
    console.log('[AgentLoop] Resuming agent from crash')
    await agentLoop.resume()
  } else if (state?.status === 'paused') {
    console.log('[AgentLoop] Agent was paused, ready to resume')
    dispatch(agentLoopActions.initialized(state))
  }
}
```

---

## Key Implementation Files

### New Files to Create

1. **Redux Slice:**
   - `/client/ygg-chat-r/src/features/agentLoop/agentLoopSlice.ts`
   - `/client/ygg-chat-r/src/features/agentLoop/agentLoopTypes.ts`
   - `/client/ygg-chat-r/src/features/agentLoop/agentLoopActions.ts`

2. **Service Layer:**
   - `/client/ygg-chat-r/src/services/AgentLoop.ts`
   - `/client/ygg-chat-r/src/services/AgentLoopTaskManager.ts`

3. **Background Worker:**
   - `/client/ygg-chat-r/electron/workers/agentLoop.ts`
   - `/client/ygg-chat-r/electron/workers/AgentLoopService.ts`

4. **UI Components:**
   - `/client/ygg-chat-r/src/components/AgentControl/AgentControl.tsx`
   - `/client/ygg-chat-r/src/components/AgentControl/AgentTaskQueue.tsx`
   - `/client/ygg-chat-r/src/components/AgentControl/AgentStats.tsx`

5. **API Routes (Local Server):**
   - Add to `/client/ygg-chat-r/electron/localServer.ts`:
     - `GET /api/local/agent-state`
     - `PUT /api/local/agent-state`
     - `POST /api/local/agent-start`
     - `POST /api/local/agent-pause`
     - `POST /api/local/agent-stop`

### Files to Modify

1. **Redux Store:**
   - `/client/ygg-chat-r/src/store/store.ts` - Add agentLoop slice

2. **App Initialization:**
   - `/client/ygg-chat-r/src/main.tsx` - Initialize agent on startup

3. **Local Server:**
   - `/client/ygg-chat-r/electron/localServer.ts` - Add agent state endpoints + worker integration

4. **Chat Container:**
   - `/client/ygg-chat-r/src/containers/Chat.tsx` - Integrate AgentControl panel (optional)

---

## Implementation Phases

### Phase 1: Core Infrastructure (Priority 1)
- [ ] Create Redux slice with basic state
- [ ] Create AgentLoop service class
- [ ] Implement system project/conversation initialization
- [ ] Implement state persistence (localStorage + SQLite)
- [ ] Basic start/pause/stop actions

### Phase 2: Agentic Turn Execution (Priority 1)
- [ ] Implement `executeAgenticTurn()` with streaming
- [ ] Tool execution integration
- [ ] Message persistence for agent turns
- [ ] Stream integration with Redux

### Phase 3: Background Worker (Priority 2)
- [ ] Create electron worker module
- [ ] Integrate with local server
- [ ] Polling-based execution
- [ ] Crash recovery logic

### Phase 4: UI & Controls (Priority 2)
- [ ] AgentControl component
- [ ] Status visualization
- [ ] Task queue UI
- [ ] Integration with Chat.tsx

### Phase 5: Advanced Features (Priority 3)
- [ ] Task queue management
- [ ] Autonomous goal generation
- [ ] Memory system (conversation summarization)
- [ ] Context management
- [ ] Rate limiting & quotas

---

## Technical Constraints

1. **Electron Only:** Agent runs only in desktop app (not web)
2. **Local Mode Only:** All agent data stored in local SQLite
3. **Single Global Stream:** No parallel agent streams
4. **Tool Access:** Agent has access to all enabled tools
5. **Persistence Required:** Must survive app restarts
6. **Non-Blocking:** Agent runs in background without blocking UI

---

## Security Considerations

1. **Tool Execution:** Agent should respect `toolAutoApprove` setting
2. **Resource Limits:** Implement quotas (turns per session, tool calls per turn)
3. **Error Handling:** Gracefully handle tool failures without crashing agent
4. **File Access:** All file operations respect `rootPath` constraints
5. **Local Only:** No external API calls without explicit user permission

---

## Testing Strategy

### Unit Tests
- Redux reducer logic
- State persistence/recovery
- Task queue management
- Stream integration

### Integration Tests
- Full agentic turn execution
- Tool calling flow
- Message persistence
- Crash recovery

### Manual Tests
- Start/pause/resume/stop flow
- Long-running sessions
- App restart during agent execution
- Tool execution with various tools
- Error handling & recovery

---

## References

### Key Files for Understanding

**Streaming & Chat:**
- [chatActions.ts](client/ygg-chat-r/src/features/chats/chatActions.ts) - Main streaming logic
- [chatSlice.ts](client/ygg-chat-r/src/features/chats/chatSlice.ts) - Redux state management
- [Chat.tsx](client/ygg-chat-r/src/containers/Chat.tsx) - Chat UI component
- [streamHelpers.ts](client/ygg-chat-r/src/features/chats/streamHelpers.ts) - Stream utilities

**Tool Execution:**
- [ToolJobManager.ts](client/ygg-chat-r/src/services/ToolJobManager.ts) - Client job interface
- [orchestrator/ToolOrchestrator.ts](client/ygg-chat-r/electron/tools/orchestrator/ToolOrchestrator.ts) - Job queue
- [toolDefinitions.ts](client/ygg-chat-r/src/features/chats/toolDefinitions.ts) - Tool schemas

**Background Workers:**
- [openrouter-reconciliation.ts](server/src/workers/openrouter-reconciliation.ts) - Worker pattern example

**Project/Conversation Management:**
- [projectActions.ts](client/ygg-chat-r/src/features/projects/projectActions.ts)
- [conversationActions.ts](client/ygg-chat-r/src/features/conversations/conversationActions.ts)

**Local Server:**
- [localServer.ts](client/ygg-chat-r/electron/localServer.ts) - Embedded server

### Moltbot Inspiration Links

- https://docs.molt.bot/concepts/agent-loop
- https://docs.molt.bot/concepts/context
- https://docs.molt.bot/concepts/memory
- https://docs.molt.bot/concepts/queue

---

## Glossary

**Term** | **Definition**
--- | ---
**Agent Loop** | Continuous execution cycle where agent generates responses, executes tools, and iterates
**Stream** | Real-time SSE connection for incremental message delivery
**Turn** | Single iteration of the agentic loop (LLM call + tool execution)
**Tool Call** | Request from LLM to execute a specific tool with arguments
**Local Mode** | Storage mode where all data is kept in local SQLite (no cloud sync)
**System Project** | Special project named "system" dedicated to agent activity
**Streaming State** | Redux state tracking active SSE streams and their buffers
**Subagent** | Tool that spawns independent agentic sessions with own tool access
**Orchestrator** | Background job queue system for managing tool executions
**Dual Sync** | Architecture supporting both local (SQLite) and cloud (Supabase) storage

---

**End of Document**
