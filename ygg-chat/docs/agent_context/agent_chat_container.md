---
paths:
  - "client/ygg-chat-r/src/hooks/useConversationSnapshotCoordinator.ts"
  - "client/ygg-chat-r/src/features/chats/conversationSnapshotCoordinator.ts"
  - "client/ygg-chat-r/src/containers/Chat.tsx"
  - "client/ygg-chat-r/src/components/ChatSelection/**"
  - "client/ygg-chat-r/src/features/chats/chatSelection*.ts"
  - "client/ygg-chat-r/src/components/ParallelChatPane/**"
---

# Agent Context: Chat Container

Last reviewed: 2026-08-01

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
- `client/ygg-chat-r/src/components/ParallelChatPane/ParallelChatPane.tsx`: session-only secondary branch transcript.
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

1. `useConversationSnapshotCoordinator(conversationIdFromUrl, conversationStorageMode)` starts an authoritative persisted fetch on every Chat route entry.
2. A same-conversation remount (for example Settings → Back) retains Redux messages, Heimdall, path, and live stream state. Only an actual A → B switch clears visible state.
3. The coordinator generation-gates requests, reconciles fetched rows with active-stream/terminal-lease-protected Redux rows, and treats other fetched omissions as authoritative deletions.
4. It rebuilds Heimdall with `buildConversationTree()` and dispatches one `conversationSnapshotApplied` action so messages/tree/path change atomically.
5. Only accepted snapshots are written to the exact React Query key; raw or superseded responses never enter the cache.
6. In Electron, Chat runs post-acceptance local mirroring and attachment hydration.
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

`handleNodeSelect(nodeId, path)` submits one in-place message target to `useChatSelection`. Heimdall graph, on-path focus clicks, and search all use this callback. `chatSelectionController.ts` resolves the target against the accepted snapshot and commits primary conversation/lineage/path/focus atomically. The transcript consumes a request-keyed scroll intent; repeated target clicks receive new request IDs.

### Message-list scrolling

- All explicit selections produce a controller-owned scroll intent, acknowledged only when the target row can be rendered/scrolled.
- Route ingestion distinguishes visits from URLs, so Back/Forward and repeated Open chat work while snapshot/token updates cannot replay stale focus.
- In-place Heimdall selection keeps history unchanged and supersedes pending route resolution.
- Conversation-only targets preserve a valid current path or resolve the latest branch; exact lineages use the existing gateway endpoint. Snapshot failures surface a retryable navigation error rather than an infinite pending state.

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

After the headless thin-client migration, the three chat thunks (`sendMessage`, `editMessageWithBranching`, `sendMessageToBranch` in `chatActions.ts`) no longer run any loop in the renderer. They POST the send/edit/branch routes on the local headless server (`http://127.0.0.1:3002`), and the server-owned loop's SSE events are streamed by `runServerChatLoop` (`src/features/chats/mainChatClient.ts`) and projected onto the existing Redux stream vocabulary by `projectServerEvent` (`src/features/chats/sseProjection.ts`). These thunks require a local-server runtime (Electron or the existing standalone target), not plain web. Chat.tsx's dispatch sites and the optimistic-bubble logic are unchanged; only what happens behind the thunk moved server-side.

Slash commands currently include:
- `/status-openai`
- `/compactify`
- `/bench on|off|status|export|reset`
- `/theme-demo on|off`

## Tool Permission and Plan Clarification Dialogs

Chat selects permission, mode-upgrade, and clarification requests only from per-stream maps using the effective view stream ID. With no selected stream, it does not show another branch's singleton request. Resolver thunks POST `/api/resume` using request `streamId`/`toolCallId`; callers pass explicit stream IDs to avoid answering another pane's request.

The dialogs are unchanged in Chat.tsx, but their **data source moved server-side** with the headless migration:
- The server-owned chat loop pauses mid-turn and emits `permission_required` / `clarify_required` SSE events. `projectServerEvent` (`src/features/chats/sseProjection.ts`) projects these onto the **same existing reducers** (`toolPermissionRequested` / `planClarificationRequested` in `chatSlice.ts`), so the slice fields Chat reads are populated exactly as before — no renderer-side tool execution or pending-promise machinery is involved.
- The four resolver thunks now `POST /api/resume` on the local server (shared helper `postDecisionResume`, `chatActions.ts`) instead of resolving in-renderer promises; the correlation ids (`streamId`, `toolCallId`) travel on the slice fields. Current resolver APIs accept explicit stream identity passed by Chat; transient resume failures can retain the dialog and typed answers.

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

## Parallel Branch Pane (Shared View, Separate Controller)

`Chat.tsx` remains the sole route/snapshot owner. It can render one optional `ParallelChatPane` next to the primary transcript and the shared Heimdall tree. The secondary pane is session-only: it resets on a conversation route change or reload. Never mount a second full `Chat` container; that would duplicate route ownership, snapshot reconciliation, global listeners, and singleton application state.

The two chat surfaces now share pane primitives under `src/components/ChatPane/`:
- `ChatInputController` keeps high-frequency draft input local to each mounted pane.
- `ChatComposerFrame` provides the same rounded glass input/control geometry and send/loading affordance.
- `ChatPaneToolbar` and `ChatPaneSurface` provide the same themed floating toolbar, rounded shell, transcript clearance, and bottom composer placement.
- `paneState.ts` contains pure pane error routing and local-path advancement helpers.

The parallel controller deliberately shares canonical conversation messages, provider/model defaults, and `streaming.byId`, but owns its branch path/lineage, draft, optimistic user row, pending stream ID, reasoning choice, scroll-follow state, decision surface, and failure recovery. It renders `ChatMessage` with the same font, grouping, truncation, custom-theme, tool viewer, subagent viewer, and message-action props as the primary transcript.

Functional invariants:
- Heimdall **Open in Parallel** captures an explicit branch path without mutating primary Redux `currentPath`.
- The pane reads branch messages with `selectDisplayMessagesFor(messages, path)` and its active run with `selectCurrentViewStreamFor(streaming, { conversationId, lineageId, path })`.
- Parallel sends pass immutable `branchPath`/`lineageId`, `streamType:'branch'`, and `updatePath:false`; completion advances only the controller-local path from server-persisted IDs.
- Permission, operation-mode upgrade, and plan clarification prompts are selected by the pane's effective stream ID and rendered inside that pane's composer.
- Durable errors are routed by stream ID, exact lineage, or parent-on-path. Failed text is restored only to the originating pane.
- Stop is stream-scoped. Closing the pane removes its view but does not silently abort a resumable server run.
- The original and parallel panes are separated by a 12px draggable divider. `chat:parallelSplitPct` persists their 20–80% allocation; mouse/touch drag resizes, Left/Right arrows adjust by 2%, and double-click restores 50/50. This divider is independent from the existing chat/Heimdall divider.
- The feature remains desktop-only; mobile remains a single visible transcript.

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
- Clear Redux messages/tree only on an actual conversation switch; retain them across same-conversation route remounts.
- Persisted snapshots may enter Redux only through the generation-gated coordinator and its atomic snapshot action.
- Do not dispatch data for another conversation into current Redux message/tree state.
- Use explicit `streamId` for sends and branches.
- Keep composer input local; avoid putting every keystroke into Redux.
- Preserve virtualizer stable keys and measurement refs when changing message rows.
- Use string ID comparison when matching messages/conversations across caches and APIs.
- Do not auto-scroll during streaming after user scroll intent.
- Keep target conversation storage mode separate from source/current storage mode for cross-conversation operations.

## Common Change Recipes

### Change how messages load

1. Update `fetchConversationMessagesTree` or the endpoint first.
2. Preserve generation gating and protected-row reconciliation in `coordinateConversationSnapshot`.
3. Apply accepted messages/tree/path atomically through `conversationSnapshotApplied`; do not restore separate loading effects.
4. Validate empty conversations, same-conversation remounts, rapid route switches, and terminal reconciliation.

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

- Build: `npm --prefix client/ygg-chat-r run build:electron` (Electron-only — the chat thunks throw outside Electron, so a web build cannot exercise the chat loop).
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

`Chat.tsx` resolves context from the selected branch after its latest auto-compaction marker. For OpenAI only, it uses the latest assistant `context_usage` snapshot whenever it is available and falls back to the local `tokenx` estimate only when usage is unavailable. For every other provider, the context bar and 85% auto-compaction gate continue using the existing estimate unchanged. Never select usage from a sibling branch or sum usage across OpenAI tool turns.


## Active-run Compaction

In-loop (mid-turn) auto-compaction now runs **server-side** inside the headless chat loop (`server/headlessServer/services/compactionService.ts`, driven by `ToolLoopService`); the renderer no longer orchestrates compaction during a running send/edit/repeat/branch tool loop. The renderer projects `context_compaction` into stream status, notices/errors, and the completed summary row with updated anchors; it does not run active-loop compaction itself.

The renderer keeps two client-side compaction controls, both via the `compactBranch` thunk (`chatActions.ts`):
- the manual `/compactify` command (`handleManualCompactifyCommand` in `Chat.tsx`);
- the pre-send auto-compaction guard in `handleSend` (runs before dispatching the send when usage reaches the 85% threshold), so the produced summary marker anchors the continuation without another user message.

## Fast-mode Composer Background

Chat Settings → Fast mode animation offers the 16 approved motion studies plus None. The preference (`chat:fastModeAnimation`) defaults to Tidal glass and syncs through `chatUi:fastModeAnimationChange` and native storage events in `src/helpers/fastModeAnimationSettings.ts`. It does not enable the service tier. Chat renders the decorative background only for `isOpenAIChatGPTProvider && fastServiceTierEnabled`.

`src/components/FastModeAnimation/` owns the effect geometry, CSS and palette. Keep the controls above the non-interactive layer, and clip only that layer (not popovers). Motion geometry follows the HTML studies; color communicates Chat/Agent mode in both light and dark appearances. `resolveComposerAgentTint` shares the original pill tint between animated/non-animated composer and previews: theme `chatInputAreaBorder`, otherwise configured border-animation colors, otherwise blue/light and orange/dark fallbacks. `getFastModePalette` keeps Chat near the neutral `chatPanelBg` surface and accents Agent across the base and moving layers. Translucent border accents supply their hue without reusing border opacity. No theme schema or preference migration is required. Mode changes update CSS variables without remounting the animation. Settings has a preview-only Chat/Agent switch, previews animate only on hover/focus, and all effects respect reduced motion.

Focused validation: `npm run test:renderer -- src/components/FastModeAnimation/FastModeAnimation.test.tsx` from the client package.

## Central primary navigation

`src/components/ChatSelection/ChatSelectionProvider.tsx` is mounted under the router in App. Primary navigation callers use `useChatNavigate` (recognized chat URLs) or `useChatSelection().select` (typed targets). The injected controller in `src/features/chats/chatSelectionController.ts` is independent of DOM/router APIs; `chatSelection.ts` defines target/route validation and shared Redux actions. Initial routes, history, links, search, sidebar and agent-pill navigation share this pipeline.

Chat remains the sole snapshot owner and supplies accepted snapshot readiness/refresh. The controller establishes conversation identity before fetching, then commits resolved selection under request/conversation guards. Late responses cannot supersede a newer request. Selection state is renderer-session only; background generation, retained previews and parallel-pane local navigation remain separate.

Snapshot cancellation is not a selection failure. The coordinator returns `accepted: false` for superseded/aborted requests even when the transport wraps `AbortError`. Each mounted conversation visit owns its refresh callbacks as well as its in-flight requests: cleanup invalidates that visit, and a retained callback from an old A visit cannot supersede the current A after A → B → A or Settings → Back. The coordinator checks caller ownership before cache/Redux commits. Within one visit, a superseded refresh follows its replacement so missing-message/lineage resolution cannot fall back using the old snapshot.

Snapshot errors carry refresh revision and selection request identity. Chat rechecks error ownership when consuming an effect, since another effect may already have started a replacement. A new same-chat selection reloads if no authoritative snapshot is available; ordinary focus on an accepted snapshot does not refetch. A successful snapshot resumes the matching failed intent without changing selection revisions. Retry creates a new intent before loading rather than relying on one refresh promise to return data. Background refresh failures do not disable an already resolved view.

Branch and Explain callbacks return explicit synchronous admission (`true` after dispatch, `false` on refusal). `ChatMessage` retains the editor/prompt and image drafts unless admitted, and checks current readiness after image preparation. Async server failures still use the existing chat error surface. Persistence-only edit and parallel-pane navigation remain separate.

Regression coverage lives in `src/hooks/useConversationSnapshotCoordinator.test.ts`, `src/features/chats/chatSelectionController.test.ts`, snapshot tests and `src/components/ChatMessage/messageSubmission.test.ts`. Run `node scripts/test-chat-selection-electron.cjs` from the client package for real React StrictMode/Redux/topbar-history lifecycle checks. It uses a hidden isolated Electron window, mocked transports and temporary user data; it never opens the real app database.

`selection.revision` identifies every explicit intent. `selection.fallbackRevision` changes when view ownership changes, allowing same-view refocus without losing a startup stream. Async sends capture their initiating revision and branch context. Do not restore independent UI path/focus dispatches; automatic stream advancement and deletion repair are separate, guarded operations.

Validation: `chatSelection.test.ts`, `chatSelectionController.test.ts`, existing lineage/projection/snapshot tests, full renderer suite, renderer typecheck and Electron build. Manually check virtualized scrolling and live navigation in Electron.
