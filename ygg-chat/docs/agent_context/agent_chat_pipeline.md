# Agent Context: Chat Pipeline

Last reviewed: 2026-06-16

## Purpose

Documents the primary chat send, stream, tool-call, branch/edit, compaction, and persistence path in the renderer.

## When to Open This File

Use this when changing:
- `sendMessage`, regeneration, branch, or edit-branch flows;
- provider dispatching;
- tool-call continuation loops;
- message persistence after generation;
- chat UI loading/stream behaviour.

## Key Files

- `client/ygg-chat-r/src/features/chats/chatActions.ts`: main orchestration thunks.
- `client/ygg-chat-r/src/features/chats/chatSlice.ts`: chat Redux state and stream reducers.
- `client/ygg-chat-r/src/features/chats/chatSelectors.ts`: branch/current view selectors.
- `client/ygg-chat-r/src/features/chats/chatTypes.ts`: chat-related types.
- `client/ygg-chat-r/src/features/chats/toolResultPersistence.ts`: tool result persistence helpers.
- `client/ygg-chat-r/src/features/chats/workspaceMutationTracking.ts`: file mutation tracking around tools.
- `client/ygg-chat-r/src/containers/Chat.tsx`: visible chat screen and command handling.
- `client/ygg-chat-r/src/components/ChatMessage/ChatMessage.tsx`: message rendering.

## Data Flow

Typical send flow:

1. `Chat.tsx` dispatches a chat thunk such as `sendMessage`.
2. The thunk resolves conversation/project/runtime/provider context.
3. It creates or updates stream state with an explicit `streamId`.
4. It builds active branch history, including compaction trimming where relevant.
5. It calls provider/local/headless generation endpoint and reads SSE chunks.
6. Text, reasoning, tool-call, and tool-result events are dispatched to Redux.
7. If tool calls are returned, local tool execution runs with permission checks and the model may continue for another turn.
8. Final assistant/tool messages are persisted and caches are updated.
9. Stream is completed or aborted and UI selectors choose the current visible stream.

## Important Invariants

- Preserve branch lineage and parent IDs when creating messages.
- Tool calls are permission-gated unless auto-approval/operation mode allows otherwise.
- Compaction is additive: it creates a synthetic system summary, not deletion.
- New multi-stream work should use explicit stream IDs, not rely on global default compatibility state.
- Hook execution can modify prompts/tool inputs or block execution; keep hook call sites ordered.

## Extension Points

- Add provider-specific behaviour near existing provider dispatch patterns.
- Add new stream event types only with matching reducer and renderer support.
- Add new tool-loop behaviour through shared helpers rather than duplicating per thunk.

## Testing and Validation

- Type/build: `npm --prefix client/ygg-chat-r run build:web` or `npm --prefix client/ygg-chat-r run build:electron`.
- For headless-equivalent orchestration changes: `npm --prefix client/ygg-chat-r run test:headless`.
- Manually verify send, tool call, denial, branch, edit-branch, and stop states if UI behaviour changes.

## Related Docs

- `agent_chat_streaming_state.md`
- `agent_tool_registry.md`
- `agent_local_tools_runtime.md`
- `summary_system_context.md`
- `stream_block_context.md`

## OpenAI Context Usage

- OpenAI/Codex `response.completed.response.usage` is normalized at the shared provider boundary and attached to assistant messages as `context_usage` plus an `openai_context_usage` content block.
- Renderer IPC and the headless tool loop both consume `OpenAiChatgptProvider`; each completed provider/tool turn replaces the previous usage snapshot rather than being summed.
- This authoritative calculation applies only to the OpenAI provider. Other providers retain Graviton's existing `tokenx` message/prompt estimation.
- For OpenAI, the renderer uses provider-reported usage whenever it is available and falls back to its local estimate only when no usage is reported. Auto-compaction retains the existing 85% model-context threshold.


## Mid-run OpenAI Compaction

OpenAI/Codex tool loops evaluate context again at the safe continuation boundary: after the assistant turn and all requested tool results are persisted, but before the next provider request. The gate uses the greater of provider-reported usage and a projected post-tool replay estimate. At 85% of the active model context window it runs the existing branch compaction operation, re-anchors the same stream to the resulting `__auto_compaction_summary__` marker, and continues with empty user content. Tools are never re-executed across this boundary. If compaction fails, continuation stops before another provider request.
