# Subagent Tool Implementation Plan

> **Historical — cloud parts removed.** Graviton is now fully local (2026-11): there is no Supabase/Railway
> account or sync, cloud storage mode, hosted OpenRouter provider, Stripe billing or web product. Sections that
> describe those are kept for history only. Current behaviour: `ygg-chat/docs/agent_context/AGENT.md`.

## Overview

Enhance the `subagent` tool to support agentic behavior with tool calling capabilities, message persistence, and configurable tool access modes.

---

## 1. Tool Definition Updates

**File:** `src/features/chats/toolDefinitions.ts`

### New Parameters

```typescript
{
  name: 'subagent',
  enabled: true,
  description: '...',
  inputSchema: {
    type: 'object',
    properties: {
      // Existing
      prompt: { type: 'string', description: '...' },
      model: { type: 'string', description: '...' },
      systemPrompt: { type: 'string', description: '...' },
      maxTokens: { type: 'integer', minimum: 1, maximum: 16384 },
      temperature: { type: 'number', minimum: 0, maximum: 2 },

      // NEW: Agentic parameters
      maxTurns: {
        type: 'integer',
        minimum: 1,
        maximum: 50,
        description: 'Maximum tool call rounds (default 10). Each turn = one LLM call + tool executions.'
      },
      orchestratorMode: {
        type: 'boolean',
        description: 'If true, use tools specified in `tools` parameter. If false, use pre-configured subagent tool list from settings. Default: false.'
      },
      tools: {
        type: 'array',
        items: { type: 'string' },
        description: 'Tool names to enable for subagent (only used when orchestratorMode=true). Example: ["read_file", "bash", "ripgrep"]'
      },
      inheritAutoApprove: {
        type: 'boolean',
        description: 'If true, inherit parent auto-approve setting. If false, always require approval for subagent tool calls. Default: true.'
      }
    },
    required: ['prompt']
  }
}
```

---

## 2. Subagent Tool Settings Storage

**File:** `src/helpers/subagentToolSettings.ts` (NEW)

### Purpose

Store pre-configured tool list for non-orchestrator mode in localStorage.

### Interface

```typescript
interface SubagentToolSettings {
  enabledTools: string[]  // Tool names enabled for subagent when orchestratorMode=false
  defaultMaxTurns: number // Default max turns if not specified
}

// Default configuration
const DEFAULT_SUBAGENT_TOOLS = [
  'read_file',
  'read_files',
  'glob',
  'ripgrep',
  'browse_web',
  'brave_search'
]

// Functions
export const loadSubagentToolSettings = (): SubagentToolSettings
export const saveSubagentToolSettings = (settings: SubagentToolSettings): void
export const getSubagentEnabledTools = (): string[]
export const setSubagentEnabledTools = (tools: string[]): void
```

### localStorage Key

`ygg_subagent_tool_settings`

---

## 3. Message Persistence Schema

**Existing table:** `messages` in `electron/localServer.ts`

### How Subagent Messages Are Stored

Subagent messages use existing columns:

- `role`: `'ex_agent'` (existing role option)
- `ex_agent_type`: `'subagent'` (new value)
- `ex_agent_session_id`: Unique ID for this subagent invocation (to group multi-turn messages)
- `conversation_id`: Same as parent conversation
- `parent_id`: ID of the assistant message that invoked the subagent

### Message Structure

```typescript
// Subagent user prompt (what parent model asked)
{
  id: uuid(),
  conversation_id: parentConversationId,
  parent_id: parentAssistantMessageId,
  role: 'ex_agent',
  ex_agent_type: 'subagent',
  ex_agent_session_id: subagentSessionId,
  content: prompt,
  // ... other fields
}

// Subagent assistant response
{
  id: uuid(),
  conversation_id: parentConversationId,
  parent_id: subagentPromptMessageId,
  role: 'ex_agent',
  ex_agent_type: 'subagent',
  ex_agent_session_id: subagentSessionId,
  content: responseText,
  tool_calls: [...],
  content_blocks: [...], // includes tool_result blocks
  // ... other fields
}
```

---

## 4. executeSubagentCall Rewrite

**File:** `src/features/chats/chatActions.ts`

### New Signature

```typescript
const executeSubagentCall = async (
  toolCall: any,
  accessToken: string | null,
  context: {
    dispatch: any
    getState: () => RootState
    conversationId: string
    parentMessageId: string  // The assistant message that called subagent
    rootPath: string | null
    operationMode: OperationMode
    auth: { userId: string; accessToken: string | null }
    queryClient: QueryClient | null
  }
): Promise<string>
```

### Implementation Flow

```
executeSubagentCall()
│
├── 1. Parse arguments (prompt, model, maxTurns, orchestratorMode, tools, etc.)
│
├── 2. Determine tool list
│     ├── orchestratorMode=true → use args.tools (filtered against available)
│     └── orchestratorMode=false → use getSubagentEnabledTools() from localStorage
│
├── 3. Generate subagentSessionId (uuid)
│
├── 4. Create & persist subagent prompt message (role='ex_agent', ex_agent_type='subagent')
│
├── 5. AGENTIC LOOP (maxTurns iterations)
│     │
│     ├── Call /generate/ephemeral with:
│     │   - prompt (first turn) or empty (continuation)
│     │   - messages: accumulated history
│     │   - tools: filtered tool definitions
│     │   - model, maxTokens, temperature, systemPrompt
│     │
│     ├── Parse SSE stream:
│     │   - Accumulate text chunks
│     │   - Collect tool_calls
│     │   - Collect reasoning blocks
│     │
│     ├── If tool_calls present:
│     │   │
│     │   ├── Create & persist assistant message with tool_calls
│     │   │
│     │   ├── For each tool_call:
│     │   │   ├── Check: if tool is 'subagent' → skip (no nested subagents)
│     │   │   ├── Execute via executeToolWithPermissionCheck()
│     │   │   │   (respects inheritAutoApprove setting)
│     │   │   └── Collect tool_result
│     │   │
│     │   ├── Update assistant message content_blocks with tool_results
│     │   │
│     │   ├── Add tool results to history
│     │   │
│     │   └── Continue loop (next turn)
│     │
│     └── If no tool_calls:
│         ├── Create & persist final assistant message
│         └── Break loop
│
├── 6. Build return value
│     ├── Final text response
│     ├── Summary of tool calls made (optional)
│     └── subagentSessionId for reference
│
└── 7. Return formatted result to parent model
```

---

## 5. Ephemeral Endpoint Enhancement

**File:** `server/src/routes/supaChat.ts`

### Current State

The `/generate/ephemeral` endpoint accepts `prompt`, `model`, `maxTokens`, etc. but does NOT accept `tools`.

### Required Changes

Add support for:

```typescript
{
  // existing...
  tools?: ToolDefinition[]  // Tool definitions to pass to LLM
  messages?: Message[]      // Conversation history for multi-turn
}
```

The endpoint should:

1. Include tools in the LLM API call
2. Parse and stream `tool_call` events (like main chat endpoint does)
3. Support continuation messages (not just single prompt)

### SSE Events to Support

```
data: { text: "..." }           // Text chunk
data: { reasoning: "..." }      // Thinking block
data: { toolCall: {...} }       // Tool call (NEW)
data: { image: "...", mimeType: "..." }  // Image output
data: [DONE]                    // Completion
```

---

## 6. Tool Filtering Logic

**File:** `src/features/chats/chatActions.ts` (in executeSubagentCall)

### Filtering Rules

```typescript
const getSubagentTools = (orchestratorMode: boolean, requestedTools: string[] | undefined): ToolDefinition[] => {
  // Get all available tools
  const allTools = getAllTools()

  // Always exclude 'subagent' to prevent recursion
  const excludedTools = new Set(['subagent'])

  let allowedToolNames: Set<string>

  if (orchestratorMode && requestedTools?.length) {
    // Orchestrator mode: use requested tools (intersection with available)
    allowedToolNames = new Set(requestedTools.filter(name => !excludedTools.has(name)))
  } else {
    // Pre-configured mode: use localStorage settings
    const configuredTools = getSubagentEnabledTools()
    allowedToolNames = new Set(configuredTools.filter(name => !excludedTools.has(name)))
  }

  // Filter and return
  return allTools.filter(t => t.enabled && allowedToolNames.has(t.name) && !excludedTools.has(t.name))
}
```

---

## 7. Permission Flow

### When `inheritAutoApprove = true` (default)

- Read `state.chat.toolAutoApprove` from Redux
- If parent has auto-approve on, subagent tool calls auto-execute
- If parent has auto-approve off, subagent tool calls show permission dialog

### When `inheritAutoApprove = false`

- Always show permission dialog for subagent tool calls
- Useful for sensitive operations or untrusted subagent prompts

### Implementation

Pass `inheritAutoApprove` to `executeToolWithPermissionCheck` context and check it there.

---

## 8. Files to Modify

| File                                    | Changes                                                  |
| --------------------------------------- | -------------------------------------------------------- |
| `src/features/chats/toolDefinitions.ts` | Add new parameters to subagent tool definition           |
| `src/features/chats/chatActions.ts`     | Rewrite `executeSubagentCall` with agentic loop          |
| `src/helpers/subagentToolSettings.ts`   | NEW - localStorage management for subagent tools         |
| `server/src/routes/supaChat.ts`         | Add `tools` and `messages` support to ephemeral endpoint |
| `electron/localServer.ts`               | No changes needed (schema already supports ex_agent)     |

---

## 9. UI Considerations (Future)

### Settings Panel

- Add "Subagent Tools" section in settings
- Checkbox list of tools to enable for non-orchestrator mode
- Default max turns setting

### Chat Display

- Messages with `ex_agent_type: 'subagent'` could be:
  - Collapsed by default
  - Shown with a different background/border
  - Grouped by `ex_agent_session_id`

---

## 10. Implementation Order

1. **Phase 1: Tool Settings Storage**
   - Create `subagentToolSettings.ts`
   - Add localStorage read/write functions

2. **Phase 2: Update Tool Definition**
   - Add new parameters to `toolDefinitions.ts`

3. **Phase 3: Server Enhancement**
   - Update `/generate/ephemeral` to accept tools and messages
   - Add tool_call event streaming

4. **Phase 4: Agentic Loop**
   - Rewrite `executeSubagentCall` with:
     - Tool filtering
     - Multi-turn loop
     - Tool execution
     - Message persistence

5. **Phase 5: Testing**
   - Test orchestrator mode with explicit tools
   - Test pre-configured mode with localStorage tools
   - Test permission flow with auto-approve on/off
   - Test max turns limit
   - Test nested subagent prevention

---

## 11. Example Usage

### Basic (no tools)

```json
{
  "name": "subagent",
  "arguments": {
    "prompt": "Summarize the key points of quantum computing",
    "model": "google/gemini-3-flash-preview"
  }
}
```

### With pre-configured tools

```json
{
  "name": "subagent",
  "arguments": {
    "prompt": "Find all TypeScript files that import React and list their exports",
    "maxTurns": 5,
    "orchestratorMode": false
  }
}
```

### With orchestrator mode (explicit tools)

```json
{
  "name": "subagent",
  "arguments": {
    "prompt": "Read the package.json and analyze the dependencies for security vulnerabilities",
    "model": "openai/gpt-4o",
    "maxTurns": 10,
    "orchestratorMode": true,
    "tools": ["read_file", "browse_web", "brave_search"],
    "systemPrompt": "You are a security analyst. Be thorough.",
    "inheritAutoApprove": false
  }
}
```

---

## 12. Return Value Format

The subagent returns a structured response to the parent model:

```typescript
interface SubagentResult {
  response: string // Final text response
  sessionId: string // ex_agent_session_id for reference
  turnsUsed: number // How many turns were used
  toolsExecuted: {
    // Summary of tool calls
    name: string
    success: boolean
  }[]
}
```

Formatted as string for tool result:

```
## Subagent Response (session: abc-123)

[Final response text here]

---
Turns: 3/10 | Tools executed: read_file (✓), ripgrep (✓), browse_web (✓)
```
