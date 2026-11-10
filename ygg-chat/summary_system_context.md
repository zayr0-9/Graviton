# Summary / Auto-Compaction System Context

This document explains how conversation summarization (called **compaction** in code) works in `ygg-chat`, focusing on:

- `client/ygg-chat-r/src/containers/Chat.tsx`
- `client/ygg-chat-r/src/features/chats/chatActions.ts`

It is intended as a quick context file for agents that need to reason about, modify, or debug summarization behavior.

---

## 1. What summarization is

In this codebase, summarization is implemented as **branch compaction**.

Instead of replacing old messages, the app creates a **new synthetic system message** containing a compact summary of prior context. That summary message is then used as the new anchor for future turns.

The summary message is identified by:

- `role: 'system'`
- `note: AUTO_COMPACTION_NOTE`
- `AUTO_COMPACTION_NOTE = '__auto_compaction_summary__'`

Defined in:
- `client/ygg-chat-r/src/features/chats/chatActions.ts`

Important consequence:
- old messages are **not deleted**
- summarization is **additive**
- future context is trimmed to start from the latest compaction message when building history for subsequent requests

---

## 2. Core mental model

The summarization flow has 3 layers:

1. **Triggering logic in `Chat.tsx`**
   - manual trigger via `/compactify`
   - automatic trigger before a send when token usage is high

2. **Summary generation in `chatActions.ts` via `compactBranch`**
   - builds a compaction prompt from message history
   - calls the active or configured model/provider
   - receives summary text
   - persists a synthetic system message

3. **History trimming / parent rebasing in `chatActions.ts`**
   - future sends use only history from the most recent summary onward
   - if the selected parent is older than the latest summary, parent is rebased to the summary message

---

## 3. Manual trigger path

Manual summarization is exposed in `Chat.tsx` as the slash command:

- `/compactify`

Main entry point:
- `handleManualCompactifyCommand`

Behavior:
- skips if a stream is active
- skips if compaction is already running
- finds the latest compaction message in `displayMessages`
- uses only messages **after** the latest compaction as source material
- requires at least 2 source messages
- uses the current last visible message as the new summary message's `parent_id`
- dispatches `compactBranch(...)`

Validation after compaction:
- returned message must be:
  - `role === 'system'`
  - `note === AUTO_COMPACTION_NOTE`
  - `parent_id === lastMessage.id`

If not, the UI logs an invalid summary error.

---

## 4. Automatic trigger during normal send

Automatic summarization is checked in `Chat.tsx` inside `handleSend` before the actual send occurs.

### Token estimation inputs

The send path estimates token usage from:

- selected project system prompt
- selected project context
- conversation system prompt
- conversation context
- message `content`
- message `content_blocks`
- message `tool_calls`

Token counting uses `estimateTokenCount`.

### Budget logic

The code uses the model context limit:

- `selectedModel.contextLength || 128_000`

(Graviton is fully local, so there is no credit-constrained budget.)

Then it computes:
- `modelContextProgress`
- `totalContextProgress`

### Auto-trigger threshold

Auto-compaction triggers when:

- context limit exists
- either progress metric is `>= 85%`
- there is a last message
- the last message is **not already** a compaction summary
- there are at least 2 source messages since the latest compaction
- no compaction is already in flight

### Source material

If a previous summary exists:
- usage accounting starts at the latest summary
- compaction source messages are the messages **after** the latest summary

If no previous summary exists:
- the full displayed message list is used

### Result handling

If `compactBranch(...)` returns a valid compaction message, then:
- `effectiveParent` is changed to the summary message ID
- the outgoing user message is sent as a child of the summary

If compaction fails or returns an invalid summary:
- send is aborted in this path

This means auto-compaction is treated as a required pre-send rewrite when the threshold is crossed.

---

## 5. Automatic trigger during branch editing / regeneration

`chatActions.ts` also performs auto-compaction in the branch editing flow (`editMessageWithBranching`).

Behavior there is analogous to normal send:
- token usage is estimated for the current branch path
- branch context limit and credit-constrained budget are calculated
- if either usage metric reaches `>= 85%`, and there are at least 2 path messages, compaction is triggered
- `compactBranch(...)` is dispatched with:
  - `conversationId`
  - `parentMessageId: activeParentId`
  - `messages: currentPathMessages`

Validation is the same:
- returned message must be a system message
- must carry `AUTO_COMPACTION_NOTE`
- must parent to the expected branch anchor

If valid:
- `activeParentId` is replaced by the summary message ID
- history for the next send turn becomes `trimHistoryToLatestCompaction([...currentPathMessages, compactedMessage])`

If invalid or failed:
- branch send/edit is aborted

---

## 6. How `compactBranch` generates the summary

`compactBranch` is the main summarization thunk in `chatActions.ts`.

### Inputs

It accepts:
- `conversationId`
- `parentMessageId`
- `messages`
- optional `providerName`
- optional `modelName`

### History preprocessing

It first trims the supplied messages with:
- `trimHistoryToLatestCompaction(messages)`

This ensures only the latest compaction segment is compacted again.

Then it converts messages into plain summary lines like:
- `USER: ...`
- `ASSISTANT: ...`
- etc.

For compaction purposes:
- `assistant` and `ex_agent` are normalized to `assistant`

### Prompting format

System prompt source:
- `providerSettings.compactionSystemPrompt`
- fallback: `DEFAULT_COMPACTION_SYSTEM_PROMPT`

Default system prompt:
- asks the model to return concise markdown preserving goals, requirements, facts, decisions, tasks, and unresolved questions, while excluding tool protocol chatter

User prompt shape:
- “Compact this branch context for continued conversation.”
- requests these sections:
  1. Objective
  2. Confirmed facts
  3. Decisions made
  4. Open tasks / next steps
  5. Risks / ambiguities
- then appends conversation history

### Provider-specific execution path

`compactBranch` supports 3 routes:

1. **LM Studio**
   - via `createLmStudioStreamingRequest(...)`

2. **OpenAI (ChatGPT)**
   - via `createOpenAIChatGPTStreamingRequest(...)`

3. **all other providers**
   - via `createStreamingRequest('/generate/ephemeral', ...)`

No tools are provided to the compaction model.

Generation settings for the generic ephemeral path:
- `temperature: 0.2`
- `maxTokens: 1200`

### Summary materialization

When summary text is received, `compactBranch` creates a new message:

- `role: 'system'`
- `content = finalSummary`
- `content_plain_text = finalSummary`
- `parent_id = parentMessageId`
- `note = AUTO_COMPACTION_NOTE`
- `model_name = resolvedModelName`

Then it:
- dispatches `chatSliceActions.messageAdded(summaryMessage)`
- dispatches `chatSliceActions.messageBranchCreated({ newMessage: summaryMessage })`
- updates React Query cache with `updateMessageCache(...)`
- syncs through `dualSync.syncMessage(...)`
- in Electron also posts directly to `localApi('/sync/message')`

So the summary becomes a normal persisted message in the conversation tree.

---

## 7. How future sends use the summary

This is the key implementation detail many agents miss.

At the beginning of `sendMessage`, the thunk builds the active path history from Redux:
- `state.chat.conversation.currentPath`

Then it calls:
- `trimHistoryToLatestCompaction(...)`

So only the suffix of the branch starting at the latest summary is used for model history.

It also checks whether the currently selected parent is still valid inside that post-compaction path.
If not, it rebases the parent to the latest summary message.

That prevents new turns from attaching to stale pre-summary ancestors.

In practice, compaction changes future request context by:
- preserving old history in storage/UI
- but only passing the latest summary + later messages to future model calls

---

## 8. Invariants agents should preserve

When editing this system, keep these invariants intact:

1. **Compaction messages must be identifiable**
   - `role: 'system'`
   - `note: AUTO_COMPACTION_NOTE`

2. **Compaction messages must attach to the intended parent**
   - send/manual path expects parent to equal the prior last message
   - branch path expects parent to equal the active branch parent

3. **History trimming must start from the latest compaction**
   - otherwise old context will leak back into subsequent requests

4. **Compaction must not run concurrently with active generation**
   - `Chat.tsx` guards against this with `streamState.active`, compacting state, and `autoCompactionInFlightRef`

5. **At least 2 source messages are required**
   - both manual and auto flows enforce this

6. **If auto-compaction is required but invalid, send/edit currently aborts**
   - changing this behavior would alter UX and failure semantics

---

## 9. User-configurable knobs

Summarization behavior is partly configurable through provider settings stored in localStorage.

Relevant fields in `providerSettingsStorage.ts`:
- `compactionProvider`
- `compactionModel`
- `compactionSystemPrompt`

Fallback prompt constant:
- `DEFAULT_COMPACTION_SYSTEM_PROMPT`

These settings determine:
- which provider/model performs compaction
- what system prompt guides summary generation

If unset:
- compaction falls back to current provider or current/default model behavior depending on call site

---

## 10. Important file map

### Trigger/UI
- `client/ygg-chat-r/src/containers/Chat.tsx`
  - `/compactify` manual trigger
  - pre-send auto-compaction threshold checks

### Summary generation / persistence / history trimming
- `client/ygg-chat-r/src/features/chats/chatActions.ts`
  - `AUTO_COMPACTION_NOTE`
  - `trimHistoryToLatestCompaction(...)`
  - `compactBranch`
  - `sendMessage`
  - `editMessageWithBranching`

### Settings
- `client/ygg-chat-r/src/helpers/providerSettingsStorage.ts`
  - `DEFAULT_COMPACTION_SYSTEM_PROMPT`
  - compaction provider/model/system-prompt settings

---

## 11. Short agent summary

If you only remember one thing:

**Summarization in ygg-chat is not destructive compression; it is tree-preserving branch compaction implemented by inserting a synthetic system summary message and then trimming future model history to begin from that summary.**
