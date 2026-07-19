# Agent Context: Message Storage Shape

Last reviewed: 2026-06-16

## Purpose

Documents how messages are stored per conversation, how the tree/branch shape is represented, and how local/cloud payloads are normalized for the renderer.

## When to Open This File

Use this when changing:
- message table/schema fields;
- `parent_id` / `children_ids` branch behaviour;
- message normalization/parsing between SQLite, cloud API, Redux, and React Query;
- bulk insertion, deletion, cloning, sync, or tree-building;
- message content block/tool call storage.

## Key Files

- `shared/types.ts`: shared `BaseMessage`, `MessageId`, `ConversationId`, `StorageMode`.
- `client/ygg-chat-r/src/features/chats/chatTypes.ts`: frontend `Message` extends shared `BaseMessage` and content block unions.
- `client/ygg-chat-r/src/features/chats/chatActions.ts`: message creation, streaming persistence, fetch/tree, bulk insert, sync.
- `client/ygg-chat-r/src/features/chats/chatSlice.ts`: Redux message list, branch/current path updates, optimistic messages.
- `client/ygg-chat-r/src/features/chats/chatSelectors.ts`: current branch/display message selectors.
- `client/ygg-chat-r/src/features/chats/pathUtils.ts`: path building over flat messages.
- `client/ygg-chat-r/electron/localServer.ts`: SQLite schema, local message endpoints, tree construction, child triggers.
- `client/ygg-chat-r/electron/headlessServer/routes/appAutomationRoutes.ts`: headless `/api/app` message endpoints.
- `client/ygg-chat-r/electron/headlessServer/persistence/messageRepo.ts`: headless message writes and child maintenance.

## IDs and Storage Modes

- `MessageId`, `ConversationId`, and `ProjectId` are typed as `string` in `shared/types.ts`.
- Code often uses string comparisons (`String(a) === String(b)`) to tolerate older numeric IDs and mixed local/cloud sources.
- `StorageMode` is `'cloud' | 'local'`.
- In Electron, local and cloud conversations can coexist. Always route message mutations using the target conversation's `storage_mode` where possible.

## Canonical Frontend Message Shape

Shared `BaseMessage` fields:

```ts
interface BaseMessage {
  id: MessageId
  conversation_id: ConversationId
  role: 'user' | 'assistant' | 'system' | 'ex_agent' | 'tool'
  content: string
  content_plain_text: string
  parent_id?: MessageId | null
  children_ids: MessageId[]
  created_at: string
  updated_at?: string
  model_name: string
  partial: boolean
  thinking_block?: string
  tool_calls?: string | any
  tool_call_id?: string | null
  content_blocks?: string | any
  has_attachments?: boolean
  attachments_count?: number
  note?: string
  note_color?: string | null
  ex_agent_session_id?: string | null
  ex_agent_type?: string | null
}
```

Frontend `Message` adds UI-only fields:

```ts
interface Message extends BaseMessage {
  pastedContext: string[]
  artifacts: string[]
  content_blocks?: ContentBlock[]
}
```

Important field meanings:
- `content`: primary text content. Can be empty when structured blocks carry the useful payload.
- `content_plain_text`: plain text copy/search field. Local SQLite also has older `plain_text_content` in some query results.
- `thinking_block`: legacy single reasoning/thinking string. Newer streams prefer `content_blocks`.
- `tool_calls`: assistant tool-call metadata. May be stored as JSON text in SQLite or already parsed in cloud responses.
- `tool_call_id`: for `role: 'tool'` messages, links result to assistant tool use.
- `content_blocks`: structured ordered blocks for text, reasoning, tools, tool results, images, responses output items, etc. May be JSON text or parsed arrays depending on source.
- `note` / `note_color`: user-authored annotation metadata used by Chat and Heimdall.
- `ex_agent_session_id` / `ex_agent_type`: external-agent/subagent/persistent-agent metadata.
- `artifacts`, `pastedContext`, and some attachment-derived data are frontend/runtime additions, not canonical DB columns.

## Local SQLite Message Table

Local Electron storage creates `messages` in `electron/localServer.ts`:

```sql
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  parent_id TEXT,
  children_ids TEXT DEFAULT '[]',
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'ex_agent', 'tool')),
  content TEXT NOT NULL,
  plain_text_content TEXT,
  thinking_block TEXT,
  tool_calls TEXT,
  tool_call_id TEXT,
  model_name TEXT DEFAULT 'unknown',
  note TEXT,
  note_color TEXT,
  ex_agent_session_id TEXT,
  ex_agent_type TEXT,
  content_blocks TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (parent_id) REFERENCES messages(id) ON DELETE CASCADE
)
```

Local indexes and helpers include:
- `idx_messages_parent_id` for parent traversal.
- Top-level-user indexes/search helpers for root user message previews.
- Triggers that append inserted child IDs to a parent's `children_ids` JSON text.

## Tree and Branch Model

Messages are stored as a tree per conversation:
- `parent_id = null` means the message is a top-level root.
- `parent_id = <message id>` means the message is a child branch/continuation under that parent.
- `children_ids` is a denormalized ordered list of direct children.

Typical single branch:

```text
user root (parent_id null)
  assistant answer (parent_id user root)
    user follow-up (parent_id assistant answer)
      assistant answer (parent_id user follow-up)
```

Branching/editing creates siblings under the same parent:

```text
user root
  assistant answer A
  assistant answer B
```

Multiple top-level roots are valid. Heimdall wraps them in a synthetic visual root when building a tree.

### Source of truth for branch order

- Local tree construction uses `children_ids` order when building the tree.
- Some renderer helpers rebuild child maps from flat `parent_id` and sort by ID or timestamp depending on context.
- When adding a message under a parent, update both the inserted message's `parent_id` and the parent's `children_ids`.
- Local SQLite triggers maintain `children_ids` on insert, but manual updates/deletes still need care.

## Normalization Rules

Local `/messages/tree` endpoints normalize SQLite rows before returning them:
- parse `children_ids` JSON text into arrays;
- parse `tool_calls` JSON text into objects/arrays or `null`;
- parse `content_blocks` JSON text into arrays or `null`;
- include attachment metadata and counts.

Frontend code must still be defensive because payloads may come from cloud, local SQLite, SSE chunks, optimistic messages, or older cached state. Existing renderers often accept both string and object forms for `tool_calls` and `content_blocks`.

## Content Blocks

Core block union in `chatTypes.ts` includes:
- `thinking`: reasoning/thought content with `index` and `content`.
- `tool_use`: tool name, ID, and input.
- `tool_result`: corresponding `tool_use_id`, content, and error flag.
- `text`: text content.
- `image`: generated/attached image URL and MIME metadata.
- `reasoning_details`: provider-specific reasoning details.

Additional provider-specific blocks can appear in practice, for example `responses_output_items`. Renderers should ignore unknown block types safely unless adding explicit support.

## Fetching Messages for a Conversation

`useConversationMessages(conversationId, storageMode)` is the preferred UI fetch path. It returns:

```ts
{
  messages: Message[]
  tree: ChatNode | null
  meta?: { storage_mode: 'local' | 'cloud' }
}
```

Routing rules:
- Electron community mode uses local `/app/conversations/:id/messages/tree`.
- Electron mixed mode checks passed `storageMode`, React Query caches, and local fallback.
- Web/cloud mode uses cloud `/conversations/:id/messages/tree`.

`Chat.tsx` then mirrors query output into Redux for legacy consumers:
- `messagesLoaded(fetchedMessages)` for flat messages;
- `heimdallDataLoaded({ treeData, subagentMap: {} })` for Heimdall.

## Building the Tree

Local `buildMessageTree(messages)`:
1. Creates `ChatNode` objects for every message.
2. Collects roots where `parent_id === null`.
3. Adds children by iterating each message's parsed `children_ids`.
4. Returns the single root directly if only one exists.
5. Returns a synthetic root with all roots as children when multiple top-level messages exist.

Renderer-side fallback `buildTreeFromMessages()` in `chatActions.ts` can build a similar tree from a flat array using `parent_id` and timestamp sorting.

## Path and Display Selection

- Redux `conversation.currentPath` is the currently selected visible branch path.
- `selectDisplayMessages` filters the flat message list to the current path and normally hides `ex_agent` messages unless persistent-agent messages should be shown.
- `buildBranchPathForMessage(messages, messageId)` walks ancestors via `parent_id`, then extends to a leaf by following the first child.
- Chat and Heimdall both rely on `currentPath` plus `focusedChatMessageId` to coordinate branch selection and scroll/focus.

## Common Write Paths

### Normal send

- `Chat.tsx` dispatches `sendMessage` with `parent` from the current path.
- The thunk persists a user message, receives/persists assistant/tool messages, and dispatches stream/reducer events.
- Reducers update flat message state and may auto-switch `currentPath` when a user branch is created.

### Edit or branch

- `Chat.tsx` `submitMessageAsBranch()` computes a branch parent:
  - if editing/branching from an assistant/ex_agent message, branch under that message's parent or from that message depending on action;
  - otherwise use the selected/original parent.
- It dispatches `editMessageWithBranching` with explicit branch context.

### Bulk insert / copying selected nodes

- `insertBulkMessages` sends message clone payloads to `/messages/bulk`.
- Heimdall transfer payloads include `source_id` and `parent_source_id` so endpoints can remap selected source relationships to fresh target message IDs.
- Local/headless bulk endpoints insert structured payloads with `parent_id = newIdBySourceId[parent_source_id]`, preserving the selected branch shape.
- If a selected message's parent is outside the selection, the copied message is inserted as a top-level root (`parent_id = null`).
- Payloads without clone parent metadata retain the legacy fallback: first copy is top-level and each subsequent copy becomes a child of the previous inserted copy.

### Delete

- Deleting a message can cascade through children because local SQLite uses `ON DELETE CASCADE` on `parent_id`.
- After delete, callers should invalidate/refetch `['conversations', conversationId, 'messages']` and refresh Heimdall data.
- If manually editing children lists, remove deleted IDs from parent `children_ids`.

## Important Invariants

- Never create a message without `conversation_id`, `role`, `content`, `children_ids`, `created_at`, and a stable ID.
- Use `parent_id: null` for top-level messages. Avoid empty string parent IDs.
- Treat `children_ids` as ordered JSON data in SQLite and as arrays in normalized frontend state.
- Parse JSON fields defensively; code may receive already parsed arrays/objects.
- When mutating a conversation other than the currently viewed one, prefer React Query invalidation over dispatching Redux `messagesLoaded`/`heimdallDataLoaded` for the target.
- Use target conversation storage mode for writes in mixed Electron mode.
- Preserve notes, content blocks, and tool metadata when copying or cloning messages unless explicitly dropping them.

## Testing and Validation

- Build: `npm --prefix client/ygg-chat-r run build:web` or `npm --prefix client/ygg-chat-r run build:electron`.
- Headless/local tests where relevant: `npm --prefix client/ygg-chat-r run test:headless`.
- Manual checks:
  - create a new top-level message and verify Heimdall root behaviour;
  - branch from user and assistant messages;
  - edit a message and verify sibling branches;
  - copy selected Heimdall nodes into a new conversation;
  - delete a branch and verify no stale child IDs remain in UI;
  - test local and cloud storage routing in Electron.

## Related Docs

- `agent_chat_container.md`
- `agent_heimdall.md`
- `agent_chat_pipeline.md`
- `agent_chat_streaming_state.md`
- `agent_electron_main_local_server.md`
- `agent_headless_server.md`

## Provider Context Metadata

OpenAI assistant messages may include nullable `context_usage`, a normalized provider-reported token snapshot. The same snapshot is also stored as an `openai_context_usage` content block for compatibility with existing SQLite message persistence. Consumers must scope it to the selected parent/child branch and ignore snapshots before the latest `__auto_compaction_summary__` marker. Non-OpenAI messages continue to use estimate-only context accounting.
