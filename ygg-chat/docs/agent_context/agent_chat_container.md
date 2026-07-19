# Agent Context: Chat Container

Last reviewed: 2026-06-16

## Purpose

Documents `client/ygg-chat-r/src/containers/Chat.tsx`, the main chat screen/container. This file coordinates conversation loading, message rendering, branch selection, streaming UI, composer behaviour, Heimdall panel integration, local agent controls, and many chat-level modals/settings.

## When to Open This File

Use this when changing:
- the main chat page layout or split-pane behaviour;
- conversation route handling or storage-mode resolution;
- React Query-to-Redux message/tree synchronization;
- message rendering/virtualization or auto-scroll behaviour;
- composer send/branch/retrigger/attachment/IDE-context flows;
- Heimdall visibility, node selection, or chat/tree synchronization;
- model/provider/reasoning/image controls shown around the composer;
- chat-level modals such as tool permission, plan clarification, auth, delete, settings, jobs.

## Key Files

- `client/ygg-chat-r/src/containers/Chat.tsx`: main container and UI orchestration.
- `client/ygg-chat-r/src/components/ChatMessage/ChatMessage.tsx`: individual message rendering/actions.
- `client/ygg-chat-r/src/components/Heimdall/Heimdall.tsx`: conversation tree panel rendered by Chat.
- `client/ygg-chat-r/src/features/chats/chatActions.ts`: send/branch/edit/delete/stream thunks.
- `client/ygg-chat-r/src/features/chats/chatSlice.ts`: chat Redux state and reducers.
- `client/ygg-chat-r/src/features/chats/chatSelectors.ts`: selected/display messages, stream selectors, Heimdall selectors.
- `client/ygg-chat-r/src/hooks/useQueries.ts`: React Query hooks for conversations/messages/models.
- `client/ygg-chat-r/src/features/chats/pathUtils.ts`: message branch path helper.
- `client/ygg-chat-r/src/features/ideContext/*`: IDE extension/file context consumed by the composer.

## High-Level Responsibilities

`Chat.tsx` is intentionally an orchestration component. It owns:
- URL conversation/project parsing and navigation.
- Storage-mode inference for local/cloud message APIs.
- Fetching message/tree data via React Query and mirroring it into Redux.
- The virtualized scrollable message list.
- Current branch/focused-message path coordination.
- Composer local input state, send controls, slash commands, and attachments.
- Provider/model/reasoning/image/local-agent options.
- Heimdall split-pane layout, visibility, and node-selection callback.
- Autoscroll, scroll-to-focused-message, and streaming anchor preservation.
- Chat-level modals and confirmation flows.

Because this file is large, prefer small focused edits and extract helpers/components only when the existing architecture already supports it or the edit would otherwise increase complexity.

## Route and Conversation Identity

Chat reads route params:

```ts
const { id: conversationIdParam, projectId: projectIdParam } = useParams()
const conversationIdFromUrl = conversationIdParam ? parseId(conversationIdParam) : null
const projectIdFromUrl = projectIdParam === 'null' ? null : projectIdParam || null
```

It also reads `location.state?.storageMode`. This is important immediately after creating a local conversation because React Query caches may not yet know the new conversation's storage mode.

`currentConversationId` in Redux is set from the URL. If no URL conversation exists, Chat dispatches `initializeUserAndConversation()`.

## Storage Mode Resolution

Chat computes `conversationStorageMode` with this priority:
1. navigation state `storageModeFromNav`;
2. `useConversationStorageMode(conversationIdFromUrl)`;
3. project conversation cache;
4. flat `['conversations']` cache fallback.

Use this value for message fetches and mutations tied to the current conversation. For mutations targeting another conversation, use that target conversation's `storage_mode` instead.

## Message and Tree Loading Flow

1. `useConversationMessages(conversationIdFromUrl, conversationStorageMode)` fetches `{ messages, tree, meta }`.
2. On route/conversation switch, Chat clears visible Redux messages immediately with `messagesLoaded([])` to prevent stale bleed.
3. When query data resolves, Chat dispatches `messagesLoaded(fetchedMessages)`.
4. In Electron, Chat calls `syncConversationToLocal()` to mirror cloud-fetched messages into local SQLite when appropriate.
5. Attachment metadata is dispatched, and binaries are fetched/converted to base64 artifacts asynchronously.
6. Chat dispatches `heimdallDataLoaded({ treeData, subagentMap: {} })` whenever tree data changes, including null/empty tree.
7. Project conversations from React Query are mirrored into Redux via `conversationsLoaded(projectConversations)` so current conversation metadata is available to selectors and prompts.

## Rendering Pipeline

### Source message sets

- `conversationMessages`: flat Redux messages for the current conversation.
- `displayMessages`: selector-derived current branch display messages. It filters to `currentPath` and normally hides `ex_agent` messages unless persistent-agent messages should show.
- `renderableMessages`: local filter of `displayMessages` that removes invalid/null rows and generated-image path hint messages.

### Parsed message payload cache

`parseMessageDataForRender(msg)` normalizes:
- `tool_calls` from string/object into arrays;
- `content_blocks` from string/object into ordered block arrays;
- legacy `thinking_block` diagnostics.

Results are cached by a signature derived from message IDs, update timestamps, content, blocks, tool calls, thinking, notes, and artifact counts.

### Virtual rows

Chat builds `MessageRenderRow[]`:
- normal message rows;
- optional grouped process-only agent/tool/reasoning runs when `chat:groupToolReasoningRuns` is enabled.

Then it builds `VirtualRenderRow[]` including:
- message rows;
- optimistic user message;
- optimistic branch message;
- live streaming row;
- generation loader row.

The list is rendered with `@tanstack/react-virtual` and measured row heights. Use stable keys (`message-${id}`, `group-${id}`, etc.) to prevent scroll jitter.

## Streaming UI and Autoscroll

Chat consumes branch-aware stream selectors from Redux:
- `selectCurrentViewStream` for the stream relevant to the current branch/view;
- a local `pendingViewStreamId` fallback to avoid flicker before selectors catch up.

Important refs:
- `userScrolledDuringStreamRef`: disables bottom following after user scroll intent.
- `streamingRowAnchorOffsetRef`: preserves the live streaming row position while final text grows.
- `finalTextStreamingStartedRef` / `hasFinalTextStreamingRef`: distinguish final text from process/tool streaming.
- `bottomRef`: sentinel used by `scrollToBottomNow()`.

Do not reintroduce unconditional auto-scroll on every stream chunk. Long final answers intentionally stop dragging the viewport once the user scrolls.

## Branch and Focus Coordination

### Heimdall node selection

`handleNodeSelect(nodeId, path)`:
1. Parses the clicked node ID and path.
2. Checks whether the selected path/focus already matches current state.
3. Marks selection as user-initiated when the click should scroll the message list.
4. During active streams, marks user scroll override to avoid bottom pinning fighting branch navigation.
5. Dispatches `conversationPathSet(parsedPath)` and `focusedChatMessageSet(parsedNodeId)` in a transition/batch.

### Message-list scrolling

- User-initiated Heimdall selections scroll via virtualizer to the focused row.
- Programmatic focused-message changes from URL hash/search scroll once using `lastFocusedScrollIdRef` as a guard.
- URL hash selection is applied once per hash via `hashAppliedRef` so it does not override later manual branch switches.
- If no path is selected after messages load, Chat auto-selects the latest branch unless a valid hash target is present.

## Composer and Send Flow

The composer is a local controlled component (`ChatInputController`) with an imperative ref. This intentionally keeps high-frequency typing out of top-level Chat state.

Normal send flow:
1. `handleComposerSubmit()` checks slash commands, then calls `handleSend(multiReplyCount)`.
2. `handleSend()` reads local input from the controller.
3. It handles retrigger mode when input is empty and the last displayed message is a user message.
4. It expands file mentions and appends IDE-selected context.
5. It chooses parent from the current selected branch tip.
6. It may run auto-compaction before sending if context usage crosses thresholds.
7. It creates optimistic user state and dispatches `sendMessage()` with explicit `streamId`.
8. Success relies on SSE/user-message chunks and reducers rather than immediately refetching.

Slash commands currently include:
- `/status-openai`
- `/compactify`
- `/bench on|off|status|export|reset`
- `/theme-demo on|off`

## Branch/Edit/Explain Actions

Chat passes message action handlers to `ChatMessage`:
- `onEdit`: `updateMessage()` then invalidates current messages query.
- `onBranch`: `submitMessageAsBranch()`.
- `onDelete`: delete confirmation then `deleteMessage()` and refetch active current messages query.
- `onResend`: creates a sibling branch from the parent user message.
- `onAddToNote`: appends selected text into conversation `research_note` and updates caches.
- `onExplainFromSelection`: creates a new child user message under the selected message.

When changing branch/edit behaviour, preserve parent computation and optimistic artifact backup behaviour so pasted/generated images do not flicker or disappear during edits.

## Heimdall Integration

Chat controls Heimdall visibility through `chat:heimdallVisible` localStorage. Defaults:
- desktop: visible;
- mobile: hidden.

Desktop layout:
- left pane: Chat message list/composer;
- right pane: Heimdall when visible;
- a draggable splitter stores `chat:leftWidthPct`.

Chat passes Heimdall:
- `chatData={heimdallData}`;
- `compactMode` from Redux;
- `loading` / `error` from Redux;
- `onNodeSelect={handleNodeSelect}`;
- `conversationId={currentConversationId}`;
- `visibleMessageId` from message-list visibility tracking;
- `storageMode={conversationStorageMode}`.

Mobile layout may render Heimdall differently/conditionally, but most desktop tree work should be validated on non-mobile first.

## Local CWD and IDE Context

- `ccCwd` is kept in Redux conversation state but loaded/persisted from the local conversation row in Electron.
- Chat clears cwd immediately on conversation change, then loads local conversation cwd; if absent, it may fall back to project cwd.
- Manual cwd changes are debounced through `updateCwd({ storageMode: 'local' })`.
- IDE extension workspace roots can populate cwd when connected or manually selected.
- User sends may append a fenced `cwd_changed` footer if a manual cwd change is pending.

## Settings and LocalStorage Keys

Important Chat-owned keys/events:
- `chat:heimdallVisible`
- `chat:leftWidthPct`
- `chat:fontSizeOffset`
- `chat:groupToolReasoningRuns`
- `chat:virtualRowsV2`
- `chat:openaiFastServiceTier`
- token usage, auto-compaction, input border, send button, streaming animation settings from helper modules.

When adding new persistent UI settings, prefer helper modules in `src/helpers/*SettingsStorage.ts` if the setting is shared beyond this file.

## Important Invariants

- Keep route-derived `conversationIdFromUrl` as the fetch identity; Redux can lag route changes.
- Clear Redux messages immediately on conversation switch to avoid stale message bleed.
- Do not dispatch data for another conversation into current Redux message/tree state.
- Use explicit `streamId` for sends and branches.
- Keep composer input local; avoid putting every keystroke into Redux.
- Preserve virtualizer stable keys and measurement refs when changing message rows.
- Use string ID comparison when matching messages/conversations across caches and APIs.
- Do not auto-scroll during streaming after user scroll intent.
- Keep target conversation storage mode separate from source/current storage mode for cross-conversation operations.

## Common Change Recipes

### Change how messages load

1. Update `useConversationMessages` or the API endpoint first.
2. Ensure Chat still receives both flat `messages` and `tree`.
3. Keep Redux sync effects scoped to `conversationIdFromUrl` and `isConversationDataFetched`.
4. Validate empty conversations and route switches.

### Add a chat-level message action

1. Add handler in Chat and pass it to `ChatMessage`.
2. Decide whether it mutates current conversation or another conversation.
3. For current conversation, invalidate/refetch `['conversations', currentConversationId, 'messages']` only as needed.
4. For other conversations, avoid Redux message dispatch; invalidate React Query keys instead.
5. Preserve branch path/focus if the action affects visible messages.

### Change Heimdall coordination

1. Update `handleNodeSelect` and Heimdall callback expectations together.
2. Verify clicked node path includes hidden/filtered messages if needed.
3. Test graph click, search focus, URL hash focus, and active stream branch switching.

### Change composer send behaviour

1. Update normal and retrigger paths deliberately.
2. Preserve file mention replacement and IDE context append.
3. Preserve auto-compaction guard if send should include compacted context.
4. Preserve optimistic message clearing on error.
5. Validate stream state and `pendingViewStreamId` handling.

## Testing and Validation

- Build: `npm --prefix client/ygg-chat-r run build:web` or `npm --prefix client/ygg-chat-r run build:electron`.
- Manual checks:
  - load existing local and cloud conversations;
  - switch routes quickly and verify no stale messages appear;
  - send normal message, retrigger, branch, edit, delete, and explain-selection;
  - stream a long answer, scroll midway, and verify viewport does not get dragged;
  - select Heimdall nodes and verify message list scroll/focus;
  - toggle Heimdall visibility and resize split pane;
  - attach images/PDFs and verify artifacts render;
  - test local cwd and IDE context insertion if Electron.

## Related Docs

- `agent_chat_pipeline.md`
- `agent_chat_streaming_state.md`
- `agent_heimdall.md`
- `agent_message_storage_shape.md`
- `agent_local_tools_runtime.md`
- `agent_hooks_system.md`

## OpenAI Context Meter

`Chat.tsx` resolves context from the selected branch after its latest auto-compaction marker. For OpenAI only, it prefers the latest assistant `context_usage` snapshot while keeping the local `tokenx` estimate as a conservative floor and for pending input. For every other provider, the context bar and 85% auto-compaction gate continue using the existing estimate unchanged. Never select usage from a sibling branch or sum usage across OpenAI tool turns.
