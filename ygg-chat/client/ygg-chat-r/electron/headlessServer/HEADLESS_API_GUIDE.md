# Ygg Headless Server API Guide (Inference)

This guide explains how to call the Electron headless server so external clients (web, mobile, CLI, other apps) can run inference.

> Source of truth used for this guide:
> - `electron/headlessServer/routes/*`
> - `electron/headlessServer/services/*`
> - `electron/headlessServer/providers/*`
> - `electron/headlessServer/contracts/headlessApi.ts`

---

## 1) What this server is

The headless server is mounted inside Electron’s local Express server and exposes:

- **Persistent chat inference over SSE** (conversation/message tree persisted in SQLite)
- **Ephemeral one-shot inference** (JSON response, no conversation persistence)
- **Provider auth/token endpoints** (OpenAI/OpenRouter token storage)
- **Capabilities + tools discovery**
- **CRUD APIs** for projects/conversations/messages (`/api/app/*`)

Default local server behavior:

- Prefers port `3002` (falls back if unavailable)
- CORS enabled (`origin: true`)
- Health endpoint: `GET /api/health`

---

## 2) Inference endpoint families

### A) Persistent conversation inference (SSE)

- `POST /api/conversations/:id/messages` → operation `send`
- `POST /api/conversations/:id/messages/repeat` → operation `repeat`
- `POST /api/conversations/:id/messages/:messageId/branch` → operation `branch`
- `POST /api/conversations/:id/messages/:messageId/edit-branch` → operation `edit-branch`

These stream Server-Sent Events (`text/event-stream`) and persist messages in DB.

### B) Ephemeral one-shot inference (JSON)

- `POST /api/headless/ephemeral/chat`
- Alias: `POST /api/headless/provider/openai/responses`

These return JSON and do not require an existing conversation.

> Note: current implementation is OpenAI ChatGPT focused. For OpenRouter streaming in Electron integrations (including custom-tool UI `REQUEST_GENERATION`), use `/api/conversations/:id/messages` with `provider: "openrouter"`.

### C) Subagent orchestration (SSE)

- `POST /api/headless/subagent/stream`

Runs one agentic subagent turn-loop server-side (shared `ToolLoopService` engine) and
streams `HeadlessSubagentStreamEvent` frames: `started` (includes `subagentRunId` + a
child `streamId`), interior `chunk` / `tool_execution` / `tool_loop` / `context_usage` /
`context_compaction` events, and a terminal `complete` (with `result` + `stats`) or `error`.

Request body: `{ conversationId, parentMessageId, toolCallId?, streamId?, prompt,
systemPrompt?, provider, modelName, tools?: string[], maxTurns?, temperature?,
operationMode?, autoApprove, rootPath?, userId?, accessToken?, accountId? }`. Tool
definitions are resolved server-side by name (the `subagent` tool is always excluded).
`provider: "openrouter"` is rejected — subagents run on the local providers only.
The transcript is persisted to `subagent_runs` / `subagent_messages` (see
`agent_subagents_orchestration.md`); closing the SSE connection aborts the run.

---

## 3) Provider + auth model

Supported providers in router:

- `openaichatgpt` (default)
- `openrouter`
- `lmstudio`

### OpenAI auth requirements

For `openaichatgpt`, provider needs:

- `accessToken` + `accountId`, **or**
- stored token in `ProviderTokenStore` for `userId`, **or**
- env fallback (`OPENAI_CHATGPT_ACCESS_TOKEN` etc.)

`accountId` can be passed directly or derived from JWT claim `chatgpt_account_id`.

---

## 4) Quick start (recommended integration flow)

## Step 1: discover capabilities

```bash
curl http://127.0.0.1:3002/api/headless/capabilities
```

You get operations, routes, SSE event types, providers, and default tool names.

## Step 2: store provider token (server-side)

```bash
curl -X POST http://127.0.0.1:3002/api/provider-auth/openai/token \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "user-123",
    "accessToken": "<OPENAI_ACCESS_TOKEN>",
    "refreshToken": "<OPENAI_REFRESH_TOKEN>",
    "expiresAt": 1760000000000,
    "accountId": "<chatgpt_account_id>"
  }'
```

## Step 3: create a conversation

```bash
curl -X POST http://127.0.0.1:3002/api/app/conversations \
  -H "Content-Type: application/json" \
  -d '{
    "user_id": "user-123",
    "title": "My API conversation",
    "project_id": null,
    "cwd": "D:/workspace/my-project"
  }'
```

## Step 4: stream inference

```bash
curl -N -X POST http://127.0.0.1:3002/api/conversations/<conversationId>/messages \
  -H "Content-Type: application/json" \
  -d '{
    "content": "Summarize README and list TODOs",
    "provider": "openaichatgpt",
    "modelName": "gpt-5.4-mini",
    "userId": "user-123",
    "rootPath": "D:/workspace/my-project"
  }'
```

`-N` keeps streaming output.

---

## 5) Persistent SSE request schema

Incoming payload accepts both camelCase and some snake_case aliases.

Core fields:

- `content: string`
- `provider: string` (default `openaichatgpt`)
- `modelName: string` (default `gpt-5.4`)
- `userId?: string`
- `parentId?: string | null`
- `messageId?: string | null` (for branch/edit/repeat forms)

Auth fields (optional if using stored tokens):

- `accessToken?: string`
- `accountId?: string`

Context + generation options:

- `systemPrompt?: string`
- `conversationContext?: string`
- `projectContext?: string`
- `temperature?: number`
- `think?: boolean`
- `attachmentsBase64?: any[]`
- `reasoningConfig?: any`
- `imageConfig?: any`

Tools + runtime execution:

- `tools?: [{ name, description?, inputSchema? }]`
- `rootPath?: string | null`
- `operationMode?: "plan" | "execute"` (default `execute`)
- `streamId?: string | null`
- `toolTimeoutMs?: number`

If `tools` is omitted, server injects default tools (built-in + enabled custom + model-visible MCP tools).

---

## 6) SSE event contract

Events are emitted as:

```text
data: {json}

```

Important event types:

- `started`
- `user_message_persisted`
- `provider_routed`
- `tool_loop` (`turn_started`, `turn_completed`, `max_turns_reached`)
- `tool_execution` (`started`, `completed`, `failed`)
- `chunk` with parts:
  - `text`
  - `reasoning`
  - `tool_call`
  - `tool_result`
- `assistant_message_persisted`
- `complete` (terminal success)
- `error` (terminal failure)

You should treat `complete` or `error` as terminal.

---

## 7) Operation semantics

Implemented in `BranchOrchestrator`:

- `send`: creates new user message under `parentId` (or root), then assistant
- `repeat`: regenerates assistant from nearest user ancestor (no new user message)
- `branch`: creates new user child under target message, then assistant under that new user
- `edit-branch`: creates edited sibling user (same parent as original), then assistant

---

## 8) Tool loop behavior (server-side)

`ToolLoopService` runs multi-turn continuation:

1. Provider generates assistant output
2. If tool calls exist, server executes tools via orchestrator
3. Tool results are persisted and appended to history
4. Provider is called again
5. Repeats until assistant response has no tool calls (or max turns)

Defaults:

- Max turns: `400`
- Provider turn timeout: `180000ms`

---

## 9) Ephemeral chat API (JSON)

`POST /api/headless/ephemeral/chat`

Request:

```json
{
  "modelName": "gpt-5.4-mini",
  "content": "Explain this code",
  "userId": "user-123",
  "history": [],
  "systemPrompt": "You are concise",
  "tools": [
    {
      "name": "read_file",
      "description": "Read a file",
      "inputSchema": { "type": "object", "properties": { "path": { "type": "string" } } }
    }
  ],
  "accessToken": "<optional>",
  "accountId": "<optional>"
}
```

Response shape:

```json
{
  "success": true,
  "provider": "openaichatgpt",
  "upstream": "responses",
  "modelName": "gpt-5.4-mini",
  "message": { "role": "assistant", "content": "..." },
  "reasoning": "...",
  "toolCalls": [],
  "contentBlocks": [],
  "raw": {}
}
```

Errors return `{ success:false, error }` with status `400/500`.

---

## 10) Token management endpoints

OpenAI:

- `POST /api/provider-auth/openai/token`
- `GET /api/provider-auth/openai/token?userId=...` → `{ success, hasToken }`
- `DELETE /api/provider-auth/openai/token?userId=...`

OpenRouter:

- `POST /api/provider-auth/openrouter/token`
- `GET /api/provider-auth/openrouter/token?userId=...`
- `DELETE /api/provider-auth/openrouter/token?userId=...`

Models discovery:

- `GET /api/provider-auth/models?userId=...`

OAuth helper routes (on local server):

- `POST /api/openai/auth/start`
- `POST /api/openai/auth/complete`

---

## 11) Minimal non-SSE client parser

Pseudo:

```ts
for each incoming chunk:
  split by "\n\n"
  for each line starting with "data:"
    const event = JSON.parse(line.slice(5))
    handle(event)
    if (event.type === "complete" || event.type === "error") done
```

Heartbeat frames are sent as SSE comments (`: heartbeat`) and should be ignored.

---

## 12) Useful companion endpoints for clients

- `GET /api/headless/capabilities` (or `/api/v1/capabilities`)
- `GET /api/headless/ephemeral/tools` (default tool catalog)
- `GET /api/headless/custom-tools`
- `PATCH /api/headless/custom-tools/:name` with `{ enabled: boolean }`
- CRUD:
  - `/api/app/projects*`
  - `/api/app/conversations*`
  - `/api/app/messages*`

---

## 13) Common failure modes

- **Conversation missing** → persistent SSE routes fail (`Conversation not found`)
- **OpenAI auth missing** → ephemeral/persistent generation fails with auth error
- **Missing `accountId` for OpenAI** when token lacks JWT claim
- **Branch/edit operations without `messageId`** →  error from orchestrator
- **SSE stream consumed as regular JSON** → client appears to “hang”

---

## 14) Recommended client strategy

1. Load capabilities + provider models.
2. Ensure provider token exists (or send per-request token).
3. Create/fetch conversation.
4. Call SSE message route.
5. Render `chunk:text`, `chunk:reasoning`, tool events incrementally.
6. Finalize on `complete`; surface `error` events explicitly.

---

If you want, I can also generate a second file with ready-to-run **TypeScript SDK wrapper** for these endpoints (including SSE stream parser and strong types).
