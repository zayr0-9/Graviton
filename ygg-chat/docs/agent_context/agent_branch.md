# Agent Context: Conversation Branching

Last reviewed: 2026-08-01

## Purpose

Explains how Ygg Chat represents branches inside a conversation. A conversation is not stored as one append-only linear transcript. It is stored as a per-conversation message tree where every message can point at a parent message and can have zero or more child messages. A branch is any selected root-to-leaf path through that tree.

Since the headless main-loop migration, branch/edit/repeat **lineage is resolved SERVER-SIDE** (in the local headless Express server on `127.0.0.1:3002`), not in the React renderer. The renderer chat thunks are thin clients that POST the branch/edit/send SSE routes and project the server's persisted-message events back onto the existing Redux reducers. See "Creating Messages and Branches" below.

## When to Open This File

Use this when changing:
- message parent/child fields or schema;
- branch creation, edit-branch, repeat/regenerate, or normal send continuation semantics;
- server-side lineage resolution in `BranchOrchestrator`, or the branch/edit/repeat SSE routes;
- the SSE→Redux branch projection (`mainChatClient` / `sseProjection`);
- current visible branch selection in Redux;
- Heimdall node selection or branch highlighting;
- URL hash message focus and search-result navigation;
- local/headless `/messages/tree` endpoints or message-copy/delete behaviour.

## Key Files

- `shared/types.ts`: shared `BaseMessage` fields, including `parent_id` and `children_ids`.
- `client/ygg-chat-r/src/features/chats/chatTypes.ts`: frontend `Message` and `conversation.currentPath` state.
- `client/ygg-chat-r/src/features/chats/pathUtils.ts`: `buildBranchPathForMessage()` builds a branch path from a flat message list.
- `client/ygg-chat-r/src/features/chats/chatSlice.ts`: reducers that keep `currentPath`, parent `children_ids`, and branch navigation in sync (`messageAdded`, `messageBranchCreated`, `streamLineageUpdated`, `streamCompleted`, `selectedNodePathSet`).
- `client/ygg-chat-r/src/features/chats/chatSelectors.ts`: `selectDisplayMessages()` filters flat messages to the selected branch for display.
- `client/ygg-chat-r/src/features/chats/chatActions.ts`: the 3 thin-client chat thunks (`sendMessage`, `editMessageWithBranching`, `sendMessageToBranch`). They POST the headless SSE routes and project the result. Branch-aware inference history and streaming persistence now run SERVER-SIDE; the old client-side branch-parent computation is gone (moved to `BranchOrchestrator`).
- `client/ygg-chat-r/src/features/chats/buildServerLoopRequest.ts`: pure builder mapping each op to its SSE route `path` + JSON body.
- `client/ygg-chat-r/src/features/chats/mainChatClient.ts`: `runServerChatLoop` — the SSE reader (fetch POST + `getReader()` stream) that drives one server run and dispatches each projected action.
- `client/ygg-chat-r/src/features/chats/sseProjection.ts`: `projectServerEvent` — pure mapping of server SSE events onto the existing chatSlice reducers; `normalizeServerMessage` coerces server (SQLite) rows to the renderer `Message` shape.
- `client/ygg-chat-r/src/containers/Chat.tsx`: dispatches the send/branch/edit thunks, sets the optimistic user bubble, auto-selects latest/hash branches, and coordinates focus. It no longer computes branch-parent placement (the server does).
- `client/ygg-chat-r/src/components/Heimdall/Heimdall.tsx`: visual tree selection and current path highlighting.
- `client/ygg-chat-r/electron/localServer.ts`: local SQLite schema, `children_ids` insert trigger, tree endpoint, and `buildMessageTree()`.
- `client/ygg-chat-r/electron/headlessServer/routes/chatRoutes.ts`: the 4 SSE routes (`send`/`repeat`/`branch`/`edit-branch`) that drive `ChatOrchestrator.runMessage`, plus `POST /api/resume` and `POST /api/conversations/:id/compact`.
- `client/ygg-chat-r/electron/headlessServer/services/chatOrchestrator.ts`: `runMessage` → `resolveExecution` (delegates to `BranchOrchestrator`) → persists the user message → emits `started` / `user_message_persisted` → runs the tool loop.
- `client/ygg-chat-r/electron/headlessServer/services/branchOrchestrator.ts`: the SINGLE authority for `send`/`branch`/`edit-branch`/`repeat` lineage for ALL renderer sends. Computes `historyLeafId` + `assistantParentId` and persists the new user message.
- `client/ygg-chat-r/electron/headlessServer/persistence/conversationRepo.ts`: `listPathToMessage()` (branch inference history) and `findNearestUserAncestor()` (repeat anchor).
- `client/ygg-chat-r/electron/headlessServer/persistence/messageRepo.ts`: headless message creation and parent `children_ids` maintenance (`createMessage`).
- `client/ygg-chat-r/electron/headlessServer/routes/appAutomationRoutes.ts`: headless app equivalents for message tree APIs.

## Core Model

Every message belongs to exactly one conversation and has:

```ts
{
  id: MessageId
  conversation_id: ConversationId
  parent_id?: MessageId | null
  children_ids: MessageId[]
}
```

Meaning:
- `conversation_id` scopes the message tree. Branches never cross conversations.
- `parent_id: null` marks a top-level root message.
- `parent_id: <id>` makes the message a direct child of another message in the same conversation.
- `children_ids` is a denormalized ordered list of direct child IDs for fast tree construction and stable sibling order.

A normal single-path chat looks linear, but it is still a tree:

```text
u1 user      parent_id null    children_ids [a1]
  a1 assistant parent_id u1    children_ids [u2]
    u2 user    parent_id a1    children_ids [a2]
      a2 assistant parent_id u2 children_ids []
```

A branch is created when a parent has more than one child:

```text
u1 user
  a1 assistant  "old answer"
  a2 assistant  "regenerated answer"
```

or:

```text
u1 user
  a1 assistant
    u2 user "old follow-up"
    u3 user "edited follow-up"
```

The branch identity is not a separate database row or branch table. The branch is identified by the chain of message IDs selected through parent/child relationships.

## Branch Identity: `currentPath`

The active visible branch is stored in Redux as:

```ts
conversation.currentPath: MessageId[]
```

`currentPath` is the ordered root-to-leaf message ID path for the branch the user is currently viewing. For example:

```ts
['u1', 'a1', 'u3', 'a3']
```

means Chat should show only those messages from the flat conversation message list, in that order. `selectDisplayMessages()` maps each ID in `currentPath` back to its message and normally hides messages outside that path. If `currentPath` is empty, the selectors fall back to showing the conversation messages sorted by `created_at`.

Important distinction:
- The full conversation is the flat set/tree of all messages for one `conversation_id`.
- The visible transcript is one selected branch path through that tree.

### Post-migration: `currentPath`/anchors come from server-persisted ids

The thin-client thunks do NOT mint message ids; the headless server assigns them and streams them back. `runServerChatLoop` (`mainChatClient.ts`) → `projectServerEvent` (`sseProjection.ts`) derives all lineage/path state from those server `*_persisted` ids:
- `started` (`event.parentId` = server `assistantParentId`) seeds the stream's root/branch anchors via `streamLineageUpdated`.
- `user_message_persisted` (server user-row id) fires `messageAdded` + `messageBranchCreated` + `streamLineageUpdated` (origin/trigger/current-branch anchors = `message.id`).
- each `assistant_message_persisted` (per turn) fires `messageAdded` + `messageBranchCreated`.
- terminal `complete` fires `messageAdded` + `messageBranchCreated` + `streamCompleted{ updatePath: true }`, which rebuilds `currentPath` to the final assistant message (`buildPathToMessage`).

`messageBranchCreated` also appends the new id to the parent's in-memory `children_ids` and auto-navigates `currentPath` when the new message belongs to the current view. So anchors and `currentPath` always derive from server-assigned ids, never locally minted ones.

## How Paths Are Built

`buildBranchPathForMessage(messages, messageId)` in `pathUtils.ts` is the shared path helper used by Chat and Heimdall.

It works in two phases:
1. Walk upward from `messageId` through `parent_id` until a root is reached, then reverse/unshift into root-to-target order.
2. From the target message, extend downward by repeatedly choosing the first child until a leaf is reached.

That second step matters for selecting an intermediate node. Clicking or focusing an ancestor should still resolve to a complete branch path, not just stop midway, so the visible transcript remains a complete conversation branch.

Some reducer-local helpers (`messageBranchCreated`, `streamCompleted`) use the simpler root-to-message path when a newly persisted message is the known branch tip. The invariant is the same: a path is a valid ancestor chain inside one conversation.

## Creating Messages and Branches

Branching means creating a new child under an existing message, or a sibling under an existing message's parent, depending on the operation. Since the headless migration the renderer no longer computes where the new node attaches — the local headless server does.

### Thin-client flow (renderer)

The three chat thunks in `chatActions.ts` are thin clients over the server-owned loop and require Electron (they throw otherwise). Each: sets an optimistic user bubble (Chat.tsx), builds the request with `buildServerLoopRequest(op, …)`, POSTs the SSE route with `runServerChatLoop`, and projects every SSE event onto the existing reducers via `projectServerEvent`. They keep NO loop control, tool execution, or client-side branch-parent computation. `buildServerLoopRequest.ts` defines the builder op as `send | edit | branch` only; the route (and the server operation name) is resolved from it:

| Thunk | builder op (`buildServerLoopRequest.ts`) | SSE route (relative, resolved to `:3002`) |
|---|---|---|
| `sendMessage` | `send` | `POST /conversations/:id/messages` |
| `sendMessageToBranch` | `branch` | `POST /conversations/:id/messages/:messageId/branch` |
| `editMessageWithBranching` | `edit` | `POST /conversations/:id/messages/:messageId/edit-branch` |

`repeat`/regenerate is a **server-only** operation (`POST /conversations/:id/messages/repeat`, `chatRoutes.ts`) — the renderer thin client does not currently issue it; see Server-side resolution below.

`systemPrompt` is deliberately omitted (the server assembles it). The renderer's `parentId`/`messageId` are the ONLY placement hints it sends; the server resolves the actual lineage from them.

### Server-side resolution (`BranchOrchestrator.resolve`)

`branchOrchestrator.ts` is the single authority for where a new node attaches, called from `ChatOrchestrator.runMessage` via `resolveExecution` (`chatOrchestrator.ts`). For each op it returns `{ historyLeafId, assistantParentId, userContentForInference, userMessage }`; the assistant response is later persisted under `assistantParentId`, and the inference history is `conversationRepo.listPathToMessage(conversationId, historyLeafId)`.

- `send`: create a user message under `request.parentId ?? null`, then the assistant under that user. The renderer still chooses the attach point — it passes the current branch tip as `parentId`, reselected to the latest `__auto_compaction_summary__` message when the tip falls outside the post-compaction path (`chatActions.ts` `sendMessage`).
- `branch`: create a user message under `request.messageId ?? request.parentId` (the message branched FROM). The renderer sends the branched-from id as `messageId`.
- `edit-branch`: create a user SIBLING under the edited message's parent — `requireMessage(request.messageId).parent_id ?? null`. The server RE-DERIVES this from the edited message; the renderer's `parentId` is used only for optimistic lineage/stream tracking, not for placement.
- `repeat`: create NO new user message; resolve the nearest user ancestor (`conversationRepo.findNearestUserAncestor`) and create a new assistant child under that user anchor (an assistant sibling of the one being regenerated). `userMessage` is null, so no `user_message_persisted` event is emitted.

All four key attachment off `parent_id`; `requireMessage` enforces that the target lives in the same conversation. After resolution, `runMessage` emits `started` (with `parentId = assistantParentId`) and, when a user message was created, `user_message_persisted` — the events the renderer projects into lineage/path state.

## Maintaining `children_ids`

Whenever a message is inserted with a non-null `parent_id`, the parent must list that new child in `children_ids`.

Local SQLite has an insert trigger in `localServer.ts`:

```sql
CREATE TRIGGER IF NOT EXISTS messages_children_insert AFTER INSERT ON messages
WHEN NEW.parent_id IS NOT NULL
BEGIN
  UPDATE messages
  SET children_ids = ... append NEW.id ...
  WHERE id = NEW.parent_id;
END;
```

Headless repos update the parent explicitly after insert (`messageRepo.createMessage` reads the parent's `children_ids`, appends, and writes it back). Frontend reducers also update the in-memory parent message in `messageBranchCreated` (from the projected `user_message_persisted` / `assistant_message_persisted` events) so the UI can navigate immediately before or while React Query refetches.

Rules:
- New messages start with `children_ids: []`.
- The parent's `children_ids` is append-only for normal insertion.
- Do not rely only on `children_ids`; `parent_id` remains the canonical ancestor pointer.
- When deleting or manually moving messages, remove stale child IDs from the old parent if the database path does not do it for you.

## Tree Fetching and Heimdall

Message fetch APIs return both:
- `messages`: normalized flat message rows;
- `tree`: a `ChatNode` tree for Heimdall.

Local `/api/local/conversations/:id/messages/tree`:
1. Loads all messages for the conversation.
2. Parses JSON fields such as `children_ids`, `tool_calls`, and `content_blocks`.
3. Builds a `ChatNode` tree using `children_ids`.
4. Wraps multiple root messages in a synthetic visual root with `id: 'root'`.

Heimdall renders the tree but uses the flat messages for robust selection. When a node is clicked, Heimdall calls `buildBranchPathForMessage(flatMessages, nodeId)`, then Chat stores that path in `conversation.currentPath` and focuses the clicked node.

The synthetic `root` is visual-only. Reducers such as `selectedNodePathSet` filter out `'root'`, `'empty'`, and empty IDs before storing a branch path.

## Display and Selection Behaviour

`selectDisplayMessages()` is the main branch-aware selector:
- if `currentPath` has IDs, it maps those IDs to messages and returns that selected chain;
- it can append hidden linear system descendants for display continuity;
- it usually filters out `ex_agent` messages unless persistent-agent display requires them;
- if no selected path resolves, it falls back to sorted unique displayable messages.

`Chat.tsx` initializes or changes `currentPath` in several places:
- URL hash focus: `#<messageId>` resolves to a full branch path once messages load.
- First load: if no selected path exists, the latest message by timestamp is resolved to a branch path and selected.
- Heimdall node click/search: selected node resolves to a branch path and focused message.
- Server SSE projection: `messageBranchCreated` (from `user_message_persisted` / `assistant_message_persisted`) and `streamCompleted{ updatePath: true }` (from terminal `complete`) move `currentPath` to the newly created branch when the new message belongs to the current view. All ids come from the server, not the renderer.

## Storage Invariants

- Keep all messages in a branch under the same `conversation_id`.
- Use `parent_id: null`, not an empty string, for roots.
- Keep `children_ids` as JSON text in SQLite and arrays in normalized frontend state.
- Compare IDs defensively with `String(id)` when crossing local/cloud/legacy boundaries.
- Treat `children_ids` as sibling order for tree rendering, but use `parent_id` for ancestor walking.
- Multiple root messages are valid in one conversation; Heimdall handles them with a synthetic root.
- A branch is a path, not an independent object. Do not add branch-specific state unless it derives from message IDs or is deliberately new metadata.
- Message ids for the main loop are minted by the headless server, not the renderer. Do not reintroduce client-side id minting or client-side branch-parent computation; project server `*_persisted` ids instead.

## Common Change Recipes

### Add a new branch-style operation

1. Decide the anchor message and whether the new message should be a child or sibling, and add a case to `BranchOrchestrator.resolve` (server-side placement).
2. Add/point a route in `chatRoutes.ts` and a `path`/body case in `buildServerLoopRequest.ts` if the renderer must trigger it.
3. Ensure the parent `children_ids` includes the new ID (repo insert + `messageBranchCreated` projection).
4. Update/invalidate message queries for the conversation.
5. Confirm the projection sets `currentPath` to the new branch if the op should navigate the user there.
6. Verify Heimdall receives a tree that includes the new child.

### Change branch selection

1. Update `buildBranchPathForMessage()` if the change is shared by Chat, Heimdall, URL hash focus, and search.
2. Update reducer helpers (`messageBranchCreated`, `streamCompleted`) only if stream/new-message auto-navigation should change.
3. Check `selectDisplayMessages()` still returns messages in `currentPath` order.
4. Test hidden/tool/system message cases because Heimdall filtering is visual-only.

### Change persistence or schema

1. Update local SQLite schema and migration/backfill if required.
2. Update local/headless insert paths (`messageRepo`, `localServer`) so parent/child maintenance remains consistent.
3. Update normalization (`normalizeServerMessage` and local normalizers) to keep frontend `children_ids` arrays.
4. Re-check tree construction for multiple roots and stale child IDs.

## Testing and Validation

Useful targeted checks:
- `npm --prefix client/ygg-chat-r run build:web`
- `npm --prefix client/ygg-chat-r run build:electron`
- `npm --prefix client/ygg-chat-r run test:headless`

Manual checks (all now driven through the headless server on `:3002`):
- send a normal message and verify the branch extends linearly;
- edit a user message and verify a sibling branch appears;
- regenerate/repeat an assistant response and verify assistant siblings under the same user;
- click ancestor and leaf nodes in Heimdall and verify Chat shows the selected branch;
- open a `#messageId` URL and verify the correct branch and focus are selected;
- delete a branch and verify no stale child IDs remain visible;
- test local and headless/mobile tree endpoints if persistence changed.

## Related Docs

- `agent_message_storage_shape.md`
- `agent_chat_pipeline.md`
- `agent_chat_streaming_state.md`
- `agent_chat_container.md`
- `agent_heimdall.md`
- `agent_headless_server.md`
