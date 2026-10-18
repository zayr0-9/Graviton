---
paths:
  - "client/ygg-chat-r/src/components/Heimdall/**"
  - "client/ygg-chat-r/src/features/chats/pathUtils.ts"
---

# Agent Context: Heimdall Conversation Tree

Last reviewed: 2026-06-16

## Purpose

Documents Heimdall, the visual conversation-tree panel used inside `Chat.tsx`. Heimdall renders messages as graph nodes, tracks branch/current-message focus, supports message selection, notes, search, subagent badges, deletion, and copying selected messages into a new conversation.

## When to Open This File

Use this when changing:
- the tree/graph panel in `client/ygg-chat-r/src/components/Heimdall/Heimdall.tsx`;
- message-node selection, right-click context menu, or selection rectangle behaviour;
- note badges/editing from the tree;
- Heimdall search, heatmap, compact/full mode, culling, zoom, pan, or touch gestures;
- creating/deleting/copying messages from selected tree nodes;
- Chat-to-Heimdall branch focus behaviour in `Chat.tsx`.

## Key Files

- `client/ygg-chat-r/src/components/Heimdall/Heimdall.tsx`: main tree renderer and interaction controller.
- `client/ygg-chat-r/src/containers/Chat.tsx`: owns panel visibility/split layout, passes tree data and focus callbacks.
- `client/ygg-chat-r/src/features/chats/chatActions.ts`: `fetchMessageTree`, `deleteSelectedNodes`, `insertBulkMessages`, and tree-building helpers.
- `client/ygg-chat-r/src/features/chats/chatSlice.ts`: selected nodes, current path, focused message, Heimdall data reducers.
- `client/ygg-chat-r/src/features/chats/chatSelectors.ts`: `selectHeimdallData`, `selectCurrentPath`, `selectFocusedChatMessageId`.
- `client/ygg-chat-r/src/features/chats/pathUtils.ts`: branch path construction used by Chat and Heimdall search/node selection.
- `client/ygg-chat-r/server/localServer.ts`: local `/messages/tree`, `/messages/bulk`, delete/update endpoints and tree conversion.
- `client/ygg-chat-r/server/headlessServer/routes/appAutomationRoutes.ts`: headless/local app equivalents for message tree APIs.

## Data Flow

1. `Chat.tsx` calls `useConversationSnapshotCoordinator(conversationIdFromUrl, conversationStorageMode)`.
2. The coordinator generation-gates the persisted fetch, reconciles active-stream and terminal-lease-protected rows, and rebuilds the tree with `buildConversationTree`.
3. Only an accepted snapshot updates the exact Query cache and dispatches `conversationSnapshotApplied`, applying flat messages, tree, and path atomically.
4. `Chat.tsx` renders `<Heimdall />` when `heimdallVisible && !isMobile`.
5. Heimdall uses `chatData` for graph layout and `state.chat.conversation.messages` for full message metadata, notes, content blocks, hidden-node expansion, and actions.
6. Clicking a node calls `onNodeSelect(nodeId, path)` back into `Chat.tsx`.
7. `Chat.tsx` submits an in-place message target to `useChatSelection`. The central controller validates and commits path/focus together; Chat consumes the request-keyed scroll intent. Graph clicks (including on-path focus) and search all use `onNodeSelect`, never independent path/focus dispatches.

## Tree Shape

Heimdall receives a `ChatNode` tree:

```ts
interface ChatNode {
  id: string
  message: string
  sender: 'user' | 'assistant' | 'ex_agent'
  children: ChatNode[]
}
```

Important details:
- The tree is derived from message `parent_id`/`children_ids` relationships.
- Multiple top-level roots are wrapped under a synthetic root node with `id: 'root'` and `message: 'Conversation'`.
- Heimdall receives the coordinator-built tree and derives a visual filter locally. Context/mode scaffolding and eligible empty nodes may be promoted away; flat Redux messages remain authoritative for complete selected paths/actions.
- `filterEmptyMessages` can hide empty/tool-only visual nodes; selection expansion then adds hidden in-between messages back into action inputs.

## Major Interaction Areas

### Graph layout, pan, zoom, culling

- Heimdall computes `positions` from `currentChatData` using iterative postorder subtree widths and preorder positioning (`heimdallTreeTraversal.ts`). Filtering, keyboard indexing and copy/transfer walks are also iterative; never introduce recursion proportional to conversation depth.
- It keeps stable offsets in refs so trees do not jump when nodes are added/removed.
- Wheel and pinch gestures zoom around pointer position.
- Pointer drag pans the graph; right-drag on empty space starts rectangle selection.
- Viewport culling renders only visible nodes/connections, with culling frozen during active pan/pinch/wheel interactions.

### Node focus and branch selection

- Left click on a message node calls `getPathWithDescendants(nodeId)`.
- That helper uses `buildBranchPathForMessage(flatMessages, nodeId)`, not the filtered tree, so hidden messages remain represented in the selected branch path.
- `Chat.tsx` receives that path and updates Redux `currentPath` and `focusedChatMessageId`.
- Chat scrolls the virtualized message list only for user-initiated Heimdall selections or explicit focused-message changes.

### Right-click and multi-select

- Right-clicking a node selects it and opens the custom context menu.
- `Ctrl`/`Meta` right-click toggles nodes into/out of the selection.
- Right-drag rectangle selection selects all visible nodes intersecting the rectangle, then `expandSelectionToHiddenBranchMessages()` adds hidden nodes between selected visible ancestors/descendants.
- Selection is stored in `state.chat.selectedNodes`.

### Context menu actions

Current actions include:
- **Copy Text**: copies selected node text in selected-node order.
- **Add/View Note**: shown for a single selected node, opens note editor.
- **Open in Parallel**: shown for one selected message when Chat provides `onOpenParallel`; resolves the existing complete branch path and opens/replaces the session-only desktop secondary transcript without changing the primary path.
- **New Chat From Here**: copies selected messages into a newly created conversation via `insertBulkMessages`.
- **Copy to Existing Chat**: copies selected messages into another conversation via `insertBulkMessages`.
- **Move to Existing Chat**: copies selected messages into another conversation, then deletes the source selection after successful insert.
- **Delete Permanently**: deletes selected message IDs with optional confirmation and refreshes the current message tree.

For selected-message copying/moving:
- Heimdall builds one structured clone payload for all three transfer actions.
- The payload includes each selected message's source ID and selected parent source ID, so target inserts can remap the copied tree to fresh message IDs.
- If a selected message's original parent is not selected, that message becomes a top-level root in the target conversation.
- It copies role, content, thinking, model/tool linkage, notes, agent fields, content blocks, and message metadata.
- Selected roots and siblings are emitted in source tree order (`children_ids` first, deterministic snapshot order as fallback), independent of click/selection order.
- `insertBulkMessages` preserves selected branch structure for structured payloads while retaining legacy linear-chain fallback for old flat payloads.
- Move refuses a partial subtree selection because deleting a selected ancestor would cascade-delete descendants that were not copied; copy remains available for such selections.

### Notes

- Note data lives on the message row: `note` and `note_color`.
- The floating toolbar's palette button replaces the compact/full toggle and opens `NoteColorLegend.tsx` on hover, focus, or click. Each row prefixes its color dot and meaning with a live count of current-conversation human top-level prompt notes (non-empty `note`), matching the sidebar's `server/topLevelUserMessages.ts` selection: recursively promote children of generated context-injection user roots, stop at ordinary messages, and exclude nested notes and non-palette colors. Its five color meanings mirror `.ygg/hooks/root_note_stop.py`; the theme-aware anchored card uses transitions.dev open/close motion with a reduced-motion fallback, and dismisses on pointer leave (unless focused), blur, Escape, or outside click. Compact/full rendering remains supported by the `compactMode` prop.
- Note edits debounce `updateMessage({ id, content, note, note_color })`.
- Heimdall stores note dialog state locally and reads/writes the current message from Redux.
- Message and note-pill hover previews share opposite-side docking: an anchor in the left half of the panel docks its preview right, and an anchor in the right half docks left. The shared layout derives the anchor's on-screen position from the same transform as `visiblePositions`, preventing the card from covering the interactive node or note pill. Preview width is capped to the opposite half on narrow panels.
- Leaving a node or note pill starts the shared `DOCKED_PREVIEW_CLOSE_DELAY_MS` timer; entering its docked card cancels it so the card can be reached and scrolled, and leaving the card restarts it. A new hover replaces the displayed content.
- Preview positioning wrappers are pointer-transparent; only the visible preview cards capture input, cancel the pending close timer, and remain marked `data-heimdall-wheel-exempt='true'`.

### Search

- Heimdall has a local modal search over the current conversation's flat messages.
- It strips Markdown into plain text asynchronously for client-side matching.
- Selecting a search result sets the branch path and focused message, then closes search.
- Search result scroll-to-node in Heimdall uses a `searchFocusPendingRef` so unrelated focus updates do not auto-center the graph.

### Subagent badges

- Heimdall builds subagent badge data from assistant messages containing `subagent` tool calls and from dedicated subagent runs fetched from local APIs in Electron (`GET /api/conversations/:id/subagents`, polled ~3s).
- Dedicated run data overrides assistant tool-call derived entries for the same parent when available.
- Badge click opens a modal showing parent task plus subagent call content blocks.
- Data source is unchanged, but subagent transcripts (`subagent_runs` / `subagent_messages`) are now written by the server-side subagent engine, not the renderer. See `agent_subagents_orchestration.md`.

## Important Invariants

- Treat filtering as visual-only. Actions should use flat Redux messages so hidden messages in a selected path are not accidentally lost.
- Do not dispatch `fetchMessageTree` for a non-current conversation from Heimdall unless you intend to replace Chat Redux state. Prefer React Query invalidation for other conversations.
- Preserve ID comparisons by string when crossing local/cloud or UUID/legacy boundaries.
- Keep `data-heimdall-wheel-exempt='true'` on scrollable overlays so the graph wheel handler does not hijack modal/list scrolling.
- Keep hover-preview positioning wrappers pointer-transparent and visible preview cards pointer-active; do not add invisible hit areas above graph nodes.
- Keep node elements carrying `data-node-id`; context-menu and hover logic depend on `closest('[data-node-id]')`.
- Avoid expensive layout recalculation by preserving memoization inputs and stable refs where possible.

## Common Change Recipes

### Add a new selected-node action

1. Add local state if the action needs a modal/pending status.
2. Reuse or extract the existing selected-message ordering/copy helper if message payloads are needed.
3. Close `showContextMenu` before opening larger UI.
4. Use target conversation storage mode for mutations, not necessarily the current/source storage mode.
5. Clear `selectedNodes` only after successful destructive/copy operation unless UX requires otherwise.
6. Invalidate the narrowest React Query keys for affected conversations.

### Change tree selection semantics

1. Update node click/right-click/rectangle selection logic together.
2. Keep hidden-node expansion behaviour aligned with `filterEmptyMessages`.
3. Verify `Chat.tsx` `handleNodeSelect` still receives a full branch path and valid focused ID.
4. Test with multiple roots, filtered empty/tool nodes, and active streams.

### Change tree rendering performance

1. Inspect `positions`, `visiblePositions`, `renderConnections`, and `renderNodes` memo dependencies.
2. Avoid adding state updates inside render loops.
3. Keep pan/zoom high-frequency values in refs where existing code does.
4. Test large conversations with zoom/pan and active streaming.

## Testing and Validation

- Build: `npm --prefix client/ygg-chat-r run build:electron`.
- Manual checks:
  - open a conversation with multiple branches and verify graph layout;
  - left-click nodes and confirm Chat scroll/path changes;
  - right-click and rectangle-select nodes;
  - copy, note, new-chat, and delete actions;
  - toggle compact/full, heatmap, and empty-message filter;
  - search and select a result;
  - verify wheel scrolling inside modals does not zoom the graph.

## Related Docs

- `agent_chat_container.md`
- `agent_message_storage_shape.md`
- `agent_chat_pipeline.md`
- `agent_chat_streaming_state.md`

## Shared keyboard commands

The app shell mounts `src/keyboard/KeyboardProvider.tsx` and `NavigationCommands.tsx`
inside the router. The latter owns the single title-bar history controller used by
both buttons and Back/Forward shortcuts. See `src/keyboard/README.md` for the catalog,
registration, overlay-blocking rules, and initial platform bindings.

Chat registers `heimdall.focus` (Cmd/Ctrl+Shift+E), opens the tree if hidden, and sends
an acknowledged one-shot focus request. Heimdall registers focused graph commands:
Up/Down explore parent/child (prefer the active path); Left/Right traverse the current
visible depth in visual order, crossing parent boundaries, and immediately open the
new branch. Enter activates the explored node through the existing `onNodeSelect`
pipeline; Space toggles action selection; Shift+F10 opens the action group. The SVG
is one Tab stop with an active descendant and a solid theme-aware keyboard focus
ring (no dotted/dashed cursor outline). `heimdallKeyboard.ts` operates on the complete
filtered tree, excluding the synthetic root, not the culled viewport. Vertical
exploration does not change the primary branch; horizontal movement does. Canonical
activation paths retain hidden messages; on-path activation preserves the current
branch. Horizontal movement stops at row edges without wrapping.

Legacy Heimdall overlays and Chat settings register command blockers. Chat Settings
→ Shortcuts opens `SettingsPane/KeyboardShortcutsModal.tsx`, which records, clears,
resets, validates, and saves catalog bindings via `keyboard/shortcutPreferences.ts`.
Saved localStorage overrides update routing and labels immediately; drafts cancel
without changing runtime bindings. Existing Chat mode/model shortcuts are not
migrated. Browser/iframe input contexts, workspace-region cycling, and a command
palette remain outside scope.

Validation: renderer suite (including `commandRegistry.test.ts` and
`heimdallKeyboard.test.ts`), `node scripts/test-chat-selection-electron.cjs` for real
StrictMode/provider/history integration, and `npm run build:electron`. Manually check
large streaming trees, note/action focus transitions, and screen-reader behavior.

## Deep conversation safety

`buildConversationTree` constructs the derived hierarchy iteratively. `finalizeChatTree` validates/copies external trees and freezes every node and children array using an explicit stack. Both Redux tree actions prepare finalized payloads; ingress middleware also handles literal/replayed actions. Keep Immer auto-freezing enabled. Canonical trees are replaced, not edited in place.

The store's serializability check skips only trees registered by that validator; all other data remains checked. Its recursive frozen-value cache is disabled. Redux DevTools serialization substitutes a diagnostic tree ID marker rather than serializing the derived hierarchy; the actual application state is not truncated.

Authoritative desktop snapshots request `includeTree=false`. App-local/gateway-local routes return all enriched message rows and `tree:null` without constructing a server tree. Default responses remain compatible. Cloud upstream still uses its existing enriched tree endpoint (outside this repository); only the local gateway's outgoing tree is omitted, so upstream serialization depth is not fixed here.

Regression coverage: `deepConversationTree.test.ts` uses 20,000-deep trees with real Redux middleware/QueryClient and graph helpers; the Electron selection smoke covers deep load/refetch/route return. Route tests verify flat enriched snapshots serialize at that depth. Never use recursive deep-equality/stringification to inspect stress-test trees.
