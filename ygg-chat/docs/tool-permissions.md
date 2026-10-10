---
paths:
  - "client/ygg-chat-r/server/headlessServer/services/chatOrchestrator.ts"
  - "client/ygg-chat-r/server/headlessServer/services/decisionBroker.ts"
  - "client/ygg-chat-r/server/headlessServer/services/toolLoopService.ts"
  - "client/ygg-chat-r/server/headlessServer/routes/chatRoutes.ts"
  - "client/ygg-chat-r/src/features/chats/chatActions.ts"
  - "client/ygg-chat-r/src/features/chats/sseProjection.ts"
  - "client/ygg-chat-r/src/containers/Chat.tsx"
---

# Tool Permission Flow Overview

Main-chat permission decisions pause the server-owned loop. The renderer displays
and answers those decisions; it does not execute the provider/tool loop.
Paths below are relative to `client/ygg-chat-r/`.

## Key Components

- **Server-owned loop**: `server/headlessServer/services/toolLoopService.ts` executes tool calls after the provider response. Renderer chat thunks start or reattach runs and project SSE.
- **Permission gate**: `createChatPausingExecutor` in `server/headlessServer/services/chatOrchestrator.ts` checks run approval policy and pauses through `DecisionBroker`. PreToolUse hooks can deny or rewrite arguments before execution. Auto-approval skips permission prompts, not hooks or operation-mode policy.
- **Renderer projection and dialog**: `src/features/chats/sseProjection.ts` projects `permission_required` into stream-keyed Redux state. `Chat.tsx` renders `ToolPermissionDialog.tsx`.
- **User responses**: `respondToToolPermission` posts `allow_once` or `deny` to `POST /api/resume`, correlated by `streamId` and `toolCallId`. Allow All posts `allow_always`; the renderer updates its default only after successful server acceptance. Transient resume failures keep the dialog open.
- **Execution**: Approved leaf calls use the shared tool orchestrator. `multi_call` bypasses its outer prompt, but nested calls re-enter normal permission and hook checks.

## User Denial Flow

1. The server receives a tool call and reaches its permission gate.
2. If approval is required, it emits `permission_required` and waits for a correlated decision.
3. The dialog posts the user's decision to `POST /api/resume`.
4. Denial prevents execution; the pausing executor throws `Tool execution denied by user`.
5. The loop classifies this as `tool_denied`, emits and persists an error tool result, and supplies the failure to the model. Denial alone does not abort the run or guarantee that generation stops. Run cancellation is handled separately.

Permission prompts are one gate alongside hooks and operation-mode policy;
auto-approved or explicitly bypassed calls do not require an interactive prompt.
`plan_md` clarification and operation-mode upgrade decisions remain interactive
independently of ordinary tool auto-approval.