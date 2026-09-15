---
paths:
  - "docs/tool-permissions.md"
---

# Tool Permission Flow Overview

This project uses an interactive tool execution flow that ensures users stay in control when the assistant needs to call a local tool. Below is a high-level description of how the feature works:

## Key Components

- **Chat Thunks (`chatActions.ts`)**: The streaming thunks (`sendMessage`, `editMessageWithBranching`, `sendMessageToBranch`) handle assistant responses. When a tool call is detected in the assistant stream, they buffer the call and execute it **after** the assistant stream completes using `executeToolWithPermissionCheck`.
- **`executeToolWithPermissionCheck`**: This helper checks the Redux state for auto-approve. If auto-approve is disabled, it dispatches `toolPermissionRequested` and waits for the user's decision. The helper either executes the tool locally (via `executeLocalTool`) or throws a specific error when the user denies permission. Throws are propagated back to the thunk to stop the generation and surface an error message.
- **Tool Permission Dialog (`ToolPermissionDialog.tsx`)**: Rendered from `Chat.tsx` whenever `toolCallPermissionRequest` is populated. The dialog displays the requested tool name, arguments, and provides “Allow”, “Deny”, and “Allow All” buttons.
- **User Response Handling (`respondToToolPermission`)**: The dialog buttons dispatch Redux thunks (`respondToToolPermission` / `respondToToolPermissionAndEnableAll`) that resolve the pending permission promise. On denial, the promise resolves with `false`, which now triggers an error from `executeToolWithPermissionCheck`, halting the ongoing generation.

## User Denial Flow

1. Assistant stream emits a tool call, stored in `assistantToolCalls`.
2. When streaming finishes, thunks iterate remaining tool calls and call `executeToolWithPermissionCheck`.
3. Permission dialog appears; user can grant or deny.
4. If the user denies, `respondToToolPermission(false)` resolves the promise and `executeToolWithPermissionCheck` throws `Tool execution denied by user`.
5. The surrounding thunk catches the error, dispatches an error chunk through `streamChunkReceived`, stops streaming, and rejects the async thunk so the UI can clear loading states and show the error.

This flow ensures tool executions happen only with consent, and cancellations do not leave stubbed tool results in the conversation.