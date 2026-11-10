# Stream Block / Tool Card Remount Context

Date: 2026-05-22

## Why this investigation exists

We replaced the old circular colored pip indicators for tool status with a minimal text shimmer on the tool call name. The shimmer still flashes even after adding an animation delay. The likely reason is not only the CSS animation loop: the tool card DOM is being remounted when the UI switches between live Redux stream state and persisted message state.

This document records the current render/data flow and the key stability issues found.

## High-level conclusion

The suspicion is correct: the current architecture can remount tool cards when streaming tool elements transition from the live stream row to persisted messages/content blocks.

There are two separate identity switches:

1. **Row-level switch** in `Chat.tsx`:
   - Live stream renders as a special virtual row with key `streaming` and `ChatMessage id='streaming'`.
   - Persisted data renders as a normal `message_row` with key `message-${msg.id}` and `ChatMessage id={msg.id}`.
   - When persistence/refetch catches up, duplicate suppression hides the `streaming` row and shows the persisted message row. React cannot preserve DOM across those different row keys/components.

2. **Tool-card key switch** inside `ChatMessage.tsx`:
   - Stream event tool cards use keys with a `stream-...` prefix and include stream event indexes.
   - Content-block tool cards use keys with a `block-...` prefix and include content-block indexes.
   - Legacy tool cards use keys with a `legacy-...` prefix and include array indexes.
   - Even if the same tool call id is preserved, the rendered key changes across render paths, so React remounts the card.

Because CSS animations start on DOM mount, `.tool-name-shimmer` restarts whenever any of these remounts happen. A delayed animation only postpones the flash; it does not solve the structural remount.

## Files inspected

- `client/ygg-chat-r/src/components/ChatMessage/chatMessageShared.ts`
- `client/ygg-chat-r/src/components/ChatMessage/ChatMessage.tsx`
- `client/ygg-chat-r/src/containers/Chat.tsx`
- `client/ygg-chat-r/src/features/chats/chatSlice.ts`
- `client/ygg-chat-r/src/features/chats/chatActions.ts`
- `client/ygg-chat-r/src/features/chats/chatSelectors.ts`
- `client/ygg-chat-r/src/features/chats/chatTypes.ts`
- `client/ygg-chat-r/src/hooks/useQueries.ts`

## Current live stream render path

### Chat container

`Chat.tsx` derives the visible stream from Redux:

- `selectCurrentViewStream`
- `effectiveViewStream`
- `streamState`

Relevant fields used:

- `streamState.active`
- `streamState.status`
- `streamState.events`
- `streamState.toolCalls`
- `streamState.liveMessageId`
- `streamState.streamingMessageId`
- `streamState.lastCompletedMessageId`
- `streamState.messageId`
- `streamState.finalMessageId`

The streaming row is added to `virtualRows` like this:

```tsx
if (showStreamingMessage) {
  rows.push({
    kind: 'streaming_message',
    key: 'streaming',
  })
}
```

And rendered as:

```tsx
<ChatMessage
  id='streaming'
  role='assistant'
  content={streamState.buffer}
  thinking={streamState.thinkingBuffer}
  toolCalls={streamState.toolCalls}
  streamEvents={streamState.events}
/>
```

This means every live tool card lives under the synthetic message id `streaming`, not under the eventual persisted message id.

### ChatMessage stream event cards

`ChatMessage.tsx` builds stream groups with:

```tsx
const streamToolGroupsByIndex = useMemo(() => buildToolCallGroupsFromStream(streamEvents), [streamEvents])
```

`buildToolCallGroupsFromStream` groups by `event.toolCall.id` / `event.toolResult.tool_use_id`, which is good.

However, `buildStreamRenderItems()` renders tool cards with keys that include the stream prefix and event index:

```tsx
const toolKey = `stream-${groupedTool.id}-${idx}`
const toolNode = renderToolCallGroupCard(groupedTool, toolKey)

items.push({
  key: `stream-tool-${groupedTool.id}-${idx}`,
  node: wrapStreamProcessNode(`stream-tool-${groupedTool.id}-${idx}`, toolNode),
})
```

`wrapStreamProcessNode()` also wraps with a separate motion div key:

```tsx
<motion.div key={`anim-${key}`} initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
  {node}
</motion.div>
```

So the live stream tool has multiple identities that are specific to the stream path:

- `stream-${toolId}-${idx}`
- `stream-tool-${toolId}-${idx}`
- `anim-stream-tool-${toolId}-${idx}`

These cannot match persisted block cards.

## Current persisted message/content-block render path

### React Query -> Redux sync

`useConversationMessages()` fetches messages from the local server in `useQueries.ts`.

`Chat.tsx` syncs query results into Redux:

```tsx
useEffect(() => {
  if (!conversationIdFromUrl || !isConversationDataFetched) return

  const fetchedMessages = conversationData?.messages ?? []
  dispatch(chatSliceActions.messagesLoaded(fetchedMessages))
}, ...)
```

`chatSlice.messagesLoaded` replaces the whole Redux message list:

```ts
state.conversation.messages = action.payload.map(message => { ... })
```

This replacement can cause normal message rows to appear/update while live stream rows are being suppressed.

### Normal message row

Persisted messages render as virtual rows with keys:

```tsx
key: row.kind === 'message' ? `message-${row.message.id}` : `group-${row.id}`
```

Normal persisted messages render:

```tsx
<ChatMessage
  id={msg.id.toString()}
  content={msg.content}
  toolCalls={displayToolCalls}
  contentBlocks={displayContentBlocks}
/>
```

This is a different `ChatMessage` instance from `id='streaming'`, so all child DOM remounts.

### Content-block tool cards

`ChatMessage.tsx` builds persisted groups with:

```tsx
const contentToolGroupsByIndex = useMemo(() => buildToolCallGroupsFromBlocks(contentBlocks), [contentBlocks])
```

`buildToolCallGroupsFromBlocks` groups by:

```ts
const id = block.id || `tool-${idx}`
```

For `tool_result`:

```ts
const id = block.tool_use_id || `tool-result-${idx}`
```

This is mostly good if persisted `tool_use.id` equals the live stream `toolCall.id`.

However, render keys are still path-specific:

```tsx
const toolKey = `block-${groupedTool.id}-${idx}`
const toolNode = renderToolCallGroupCard(groupedTool, toolKey)

items.push({
  key: `block-tool-${groupedTool.id}-${idx}`,
  node: toolNode,
})
```

So persisted cards cannot reuse stream cards.

## Legacy fallback render path

If neither `streamEvents` nor `contentBlocks` exist, legacy `toolCalls` render with:

```tsx
renderToolCallGroupCard(..., `legacy-${toolCall.id}-${idx}`)
```

This is also incompatible with stream/block keys.

## Duplicate suppression behavior

`Chat.tsx` computes:

```tsx
const isLiveStreamingMessageAlreadyRendered =
  liveDuplicateSuppressionMessageId != null &&
  messageRowIndexByMessageId.has(String(liveDuplicateSuppressionMessageId))

const isCompletedStreamMessageAlreadyRendered =
  completedDuplicateSuppressionMessageId != null &&
  messageRowIndexByMessageId.has(String(completedDuplicateSuppressionMessageId))

const isStreamingMessageAlreadyRendered =
  isLiveStreamingMessageAlreadyRendered ||
  ((shouldPreserveProcessStreamRow || liveDuplicateSuppressionMessageId == null) &&
    isCompletedStreamMessageAlreadyRendered)

const showStreamingMessage = !isStreamingMessageAlreadyRendered && hasStreamingMessageContent
```

This is useful to avoid duplicate live and persisted messages, but it guarantees a row-level switch: once the completed/live message id appears in the normal message list, the streaming row can disappear. The tool card is then recreated under the normal persisted row.

## Data identity appears mostly preserved, but render identity is not

The stream reducer stores tool calls by id:

```ts
const existingIndex = stream.toolCalls.findIndex(tc => tc.id === chunk.toolCall!.id)
```

Stream events are upserted by tool call id / tool result id:

```ts
e => e.type === 'tool_call' && e.toolCall?.id === chunk.toolCall!.id

e => e.type === 'tool_result' && e.toolResult?.tool_use_id === chunk.toolResult!.tool_use_id
```

Content blocks are usually persisted with the same id:

```ts
content_blocks: assistantToolCalls.map(tc => ({
  type: 'tool_use',
  id: tc.id,
  name: tc.name,
  input: tc.arguments,
}))
```

Tool results use the same id:

```ts
{
  type: 'tool_result',
  tool_use_id: toolCall.id,
  content,
  is_error: isError,
}
```

So the raw tool id can be stable. The problem is primarily that React keys are not stable across render paths and the parent row also changes identity.

## Migration hiccups / risks found

### 1. `updateMessageCache` appends duplicate ids

In `chatActions.ts`, `updateMessageCache` always appends:

```ts
const updatedMessages = [...existingData.messages, newMessage]
```

It does not upsert by `newMessage.id`. If a message is already in the React Query cache and a later SSE/persist path calls `updateMessageCache` again with the same id, the cache can temporarily contain duplicates. `selectDisplayMessages` dedupes Redux messages by id in some paths, but the query cache and subsequent `messagesLoaded` replacement can still cause churn.

Recommendation: change `updateMessageCache` to upsert by id instead of append-only.

### 2. `messagesLoaded` replaces the message array wholesale

`messagesLoaded` does:

```ts
state.conversation.messages = action.payload.map(...)
```

This is expected for fetched canonical data, but during active streaming it can switch the UI from live stream to persisted rows. It also invalidates memo signatures because message object references and `updated_at`/artifact counts may differ.

Recommendation: during active stream, consider merging fetched messages into Redux by id while preserving existing message object for unchanged messages. More importantly, use the completed live message id to avoid rendering the synthetic streaming row when an equivalent persisted row is available, but be aware this will remount.

### 3. Content-block indexes are not always set when synthesized

Some synthesized blocks are created without explicit `index`, for example:

```ts
content_blocks: assistantToolCalls.map(tc => ({
  type: 'tool_use',
  id: tc.id,
  name: tc.name,
  input: tc.arguments,
}))
```

`parseMessageDataForRender` assigns indexes when missing, so this works, but index-based render keys become dependent on array position. If later persistence adds/sorts indexes differently, keys can shift.

Recommendation: avoid including `idx` in tool card keys when `group.id` exists.

### 4. The stream row is keyed as a singleton `streaming`

Only one row identity is used for all streaming messages:

```ts
key: 'streaming'
```

This is fine for a single live row, but it is not tied to `streamState.liveMessageId` or `streamState.id`. If streams overlap or branch streams switch, the same row can represent different messages. This can preserve state when it should not, and remount when the persisted row appears.

Recommendation: if keeping a separate streaming row, key it by stream id or live message id: `streaming-${streamState.id ?? streamState.liveMessageId ?? 'active'}`. This does not solve persisted transition remount, but makes stream identity clearer.

## What would actually reduce/remedy shimmer flash

### Option A: use stable tool keys within each path

This is low risk and should be done regardless:

- Stream tool item/card key should be based on stable tool id only, not event index.
- Content block tool item/card key should use the same stable tool id when available.
- Legacy fallback should use the same stable tool id when available.

Example helper in `ChatMessage.tsx`:

```ts
const buildStableToolRenderKey = (group: ToolCallRenderGroup, fallbackIndex: number | string) =>
  `tool-${id}-${group.id || fallbackIndex}`
```

Then use it in all tool render paths:

```tsx
const toolKey = buildStableToolRenderKey(groupedTool, idx)
```

This will preserve tool cards across updates within the same `ChatMessage` instance/path, such as tool result upserts or content block updates. It will not preserve DOM across `id='streaming'` -> `id={messageId}` row replacement.

### Option B: give the streaming `ChatMessage` the live message id when available

Currently the streaming row always uses:

```tsx
<ChatMessage id='streaming' ... />
```

If `streamState.liveMessageId` exists, use it:

```tsx
<ChatMessage id={(streamState.liveMessageId ?? streamState.streamingMessageId ?? 'streaming').toString()} ... />
```

This helps internal keys if they include message id, but the parent row is still different (`streaming` row vs `message-${msg.id}`), so React still remounts at row transition.

### Option C: render live stream content into the persisted row when the live message id exists

This is the more structural fix.

Instead of always rendering stream content in a separate `streaming_message` row, detect whether `streamState.liveMessageId` corresponds to a row in `messageRenderRows`. If yes, pass `streamEvents` and live buffers into that existing message row's `ChatMessage` rather than adding a separate streaming row.

Desired behavior:

- Before the assistant message exists in Redux/persistent list: render synthetic streaming row.
- After the assistant message exists: keep rendering the same message row and feed it live `streamEvents` until stream completion.
- On final persistence: same parent `VirtualizedRowContainer` key (`message-${msg.id}`), same `ChatMessage id`, same tool card key (`tool-${messageId}-${toolId}`), so the DOM can survive updates.

This is the best route if we want a traveling shimmer without remount flash.

### Option D: keep a non-remount-sensitive animation

If structural work is too risky now, the visual workaround is to avoid `color: transparent` gradient shimmer and use an opacity/brightness pulse. This does not solve remounts but makes remounts much less visible.

## Recommended immediate code changes

1. Add a helper in `ChatMessage.tsx`:

```ts
const getToolRenderKey = (group: ToolCallRenderGroup, fallback: string | number) =>
  `tool-${id}-${group.id || fallback}`
```

2. Replace these key forms:

- `stream-${groupedTool.id}-${idx}`
- `stream-tool-${groupedTool.id}-${idx}`
- `stream-fallback-${toolCall.id}-${idx}`
- `stream-fallback-tool-${toolCall.id}-${idx}`
- `block-${groupedTool.id}-${idx}`
- `block-tool-${groupedTool.id}-${idx}`
- `legacy-${toolCall.id}-${idx}`

with the stable helper when a tool id exists.

3. Keep indexes only as fallback when there is no tool id.

4. Upsert React Query message cache in `updateMessageCache` instead of appending duplicates.

## Recommended larger follow-up

Move live stream rendering into the eventual persisted message row as soon as `streamState.liveMessageId` or `streamState.streamingMessageId` is known and that message appears in `messageRenderRows`.

This likely requires changes in `Chat.tsx` around the normal `message_row` render branch:

- Determine whether `msg.id` equals `streamState.liveMessageId` / `streamState.streamingMessageId` / perhaps `streamState.lastCompletedMessageId` during `waiting_for_tool`.
- If yes, pass stream props to that `ChatMessage`:

```tsx
const shouldOverlayStreamOnMessage = String(msg.id) === String(streamState.liveMessageId ?? streamState.streamingMessageId)

<ChatMessage
  ...
  content={shouldOverlayStreamOnMessage ? streamState.buffer : msg.content}
  thinking={shouldOverlayStreamOnMessage ? streamState.thinkingBuffer : displayThinking}
  toolCalls={shouldOverlayStreamOnMessage ? streamState.toolCalls : displayToolCalls}
  streamEvents={shouldOverlayStreamOnMessage ? streamState.events : undefined}
/>
```

Care is needed for multi-turn tool loops where `lastCompletedMessageId` is a completed assistant tool-call message while the stream remains active in `waiting_for_tool`.

## Bottom line

The current shimmer flash is a symptom of render identity churn. Stable keys within `ChatMessage` will reduce remounts during incremental updates, but they cannot preserve DOM across the separate synthetic streaming row and persisted message row. To fully fix the shimmer flash while keeping a traveling shimmer, we need to avoid that row-level handoff or make the animation robust to remounts.

## Parallel branch / multi-stream constraints

Important clarification: this app supports multiple active streams at once, including parallel branches that can each run their own tool calls. Any fix for shimmer remounts must preserve that behavior.

The current stream selection is branch-aware:

- `chatSlice.streaming.byId` can hold multiple streams.
- `chatSlice.streaming.activeIds` tracks active streams.
- `selectCurrentViewStream` ranks active streams against the current branch path and current conversation id.
- `Chat.tsx` renders only the `effectiveViewStream` for the currently selected branch/view.

This means the UI intentionally switches the visible live stream when the user switches branches. That branch switch is a legitimate identity change and should not try to preserve the exact same tool-card DOM between different branch streams.

### Constraint for any stable-key fix

Stable keys must be scoped to the branch/message/stream identity. They must not be only `tool-${toolId}` globally, because different active branches could theoretically emit the same provider/tool id or the same fallback id. A globally scoped key could cause React to preserve the wrong DOM/state across branch switches.

Safer key scope:

```ts
const getToolRenderKey = (group: ToolCallRenderGroup, fallback: string | number) =>
  `tool-${id}-${group.id || fallback}`
```

Where `id` is the current `ChatMessage` id. This is good for persisted rows, but during live streaming `id` is currently often the synthetic value `'streaming'`, which is too broad for parallel streams if multiple stream rows ever become visible or if stream identity changes underneath the same synthetic row.

Even safer for live stream paths:

```ts
const getToolRenderKey = (group, fallback) =>
  `tool-${messageOrStreamScope}-${group.id || fallback}`
```

Where `messageOrStreamScope` should be one of:

1. persisted `messageId` when known,
2. `streamState.liveMessageId` / `streamState.streamingMessageId` when known,
3. otherwise `streamState.id`,
4. otherwise the current `ChatMessage id` fallback.

### Constraint for rendering stream into persisted rows

The larger proposed fix — rendering live stream data inside the eventual persisted message row — is valid only when the active stream is known to correspond to that message row.

It should be gated by both conversation and stream/message identity, for example:

```ts
const streamMessageScope =
  streamState.liveMessageId ??
  streamState.streamingMessageId ??
  streamState.messageId ??
  streamState.lastCompletedMessageId ??
  streamState.finalMessageId

const shouldOverlayStreamOnMessage =
  streamState.active &&
  streamMessageScope != null &&
  String(msg.id) === String(streamMessageScope)
```

For multi-turn tool loops, care is needed:

- `liveMessageId` / `streamingMessageId` represent the currently streaming assistant turn.
- `lastCompletedMessageId` / `messageId` may represent a completed assistant tool-call turn while the stream remains active in `waiting_for_tool`.
- During `waiting_for_tool`, it may be correct to keep process information visible for the completed tool-call message, but it must not accidentally overlay a subsequent branch stream onto the wrong persisted row.

### Branch switching expected behavior

When the user switches branches:

- It is acceptable for the visible tool shimmer to remount if the visible active stream is genuinely different.
- It is not acceptable for a stream from branch A to keep rendering in branch B because a key was too broad or a fallback row was reused.
- Any cache of tool render keys should be derived from stream/message identity, not from array position alone.

### Revised recommendation with parallel branches in mind

1. Do **not** use global keys like `tool-${toolId}`.
2. Use keys scoped by persisted message id where possible.
3. For live streams, pass a stream/message scope into `ChatMessage`, e.g. `streamRenderScope={streamState.liveMessageId ?? streamState.streamingMessageId ?? streamState.id}`.
4. Use stable keys like:

```ts
`tool-${streamRenderScope ?? id}-${group.id || fallback}`
```

5. Preserve the separate synthetic streaming row as a fallback for streams whose live message has not appeared in the message list yet.
6. Only overlay stream events into a persisted message row when the active branch-aware `effectiveViewStream` explicitly matches that row.
7. Keep `selectCurrentViewStream` as the source of truth for which branch stream is visible; do not scan all active streams in the render layer unless rendering multiple visible branch panes intentionally.

This means the structural fix is still possible, but it should be stream-scoped and branch-aware rather than trying to globally preserve DOM across all streams.
