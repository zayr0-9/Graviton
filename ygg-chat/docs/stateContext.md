---
paths:
  - "docs/stateContext.md"
---

# Graviton Application State Overview

This document describes how state is managed across the main Graviton application surfaces, with a focus on the core user-facing areas of the product:

- `src/containers/Chat.tsx`
- `src/containers/sideBar.tsx`
- `src/containers/Settings.tsx`
- `src/containers/rightBar.tsx`
- `src/hooks/useQueries.ts`
- `src/features/chats/*`

Graviton uses two complementary state systems:

1. **Redux** for interactive runtime state
2. **TanStack Query** for fetched and persisted data

That separation is deliberate. Graviton is not only a CRUD-style application; it is a branching, streaming, tool-using AI workspace. Some state behaves like long-lived data, while other state behaves like a live runtime.

---

## 1. State architecture at a glance

### Redux is used for live interaction state

Redux manages state that is tightly coupled to the current UI session and changes frequently during use. In practice this includes:

- chat composition state
- active streaming state
- current branch/path selection
- Heimdall graph state
- optimistic messages
- tool permission prompts
- active conversation focus
- integrated IDE context
- right bar UI state

This state is primarily defined in:

- `src/features/chats/chatSlice.ts`
- `src/features/conversations/conversationSlice.ts`
- `src/features/projects/projectSlice.ts`
- `src/features/ui/uiSlice.ts`
- `src/features/ideContext/*`

### TanStack Query is used for fetched and cached data

TanStack Query manages resource-oriented data that comes from the local server or cloud APIs. This includes:

- projects
- conversations
- conversation message trees
- research notes
- model lists
- directory listings and file search
- local git data
- global agent messages and queued tasks

This logic is centralized in:

- `src/hooks/useQueries.ts`

The Query cache is the shared data plane for Graviton. It provides request deduplication, caching, invalidation, and optimistic cache updates across pages.

---

## 2. Why Graviton uses both Redux and Query

The split reflects two different kinds of state.

### Redux fits interaction-heavy state

A branching chat UI needs state that updates immediately and often, sometimes many times per second. Examples include:

- token streaming buffers
- branch switching
- message editing and branching state
- pending tool calls
- permission dialogs
- selected nodes in the branch graph

This kind of state is best treated as application runtime state.

### Query fits persisted resource state

Projects, conversations, message trees, and workspace data are naturally modeled as cached resources. Query is well suited here because it provides:

- data fetching
- cache reuse
- request deduplication
- cache invalidation
- mutation helpers
- optimistic updates

In practice, Graviton uses Redux as the interaction layer and Query as the data layer.

---

## 3. Redux structure

The Redux store is configured in:

- `src/store/store.ts`

The most relevant slices for the main application flow are:

- `chat`
- `conversations`
- `projects`
- `ui`
- `ideContext`

### 3.1 Chat slice

The `chat` slice is the core interaction runtime for Graviton.

It contains several distinct domains:

#### Provider and composition state

- current provider
- current input
- model override
- validation state
- sending and compaction flags
- image drafts
- optimistic message state
- branch editing state

#### Multi-stream state

Streaming is modeled as a collection of streams rather than a single boolean loading flag.

Important fields include:

```ts
streaming: {
  activeIds: string[]
  byId: Record<string, StreamState>
  primaryStreamId: string | null
  lastCompletedId: string | null
}
```

Each stream records:

- whether it is active
- text and reasoning buffers
- ordered stream events
- tool calls
- linked message ids
- lineage metadata
- stream type (`primary`, `branch`, `subagent`, `tool`)

This is what allows Graviton to support branch-aware streaming and background work.

#### Conversation runtime state

The active chat session also keeps a working set in Redux:

- current conversation id
- current branch path
- visible messages
- focused message id
- conversation context
- current working directory for code-related actions

This is the active session state for the current chat view, not the entire persisted history of the app.

#### Heimdall state

Heimdall is the branch graph view. Redux stores:

- tree data
- subagent mapping
- loading/error state
- compact mode
- fetch timestamps

#### Tooling state

The chat slice also stores:

- tool definitions available to the runtime
- tool permission requests
- auto-approve state
- operation mode

### 3.2 Conversations slice

The `conversations` slice is lighter and focuses on app-wide conversation metadata.

It stores:

- loaded conversation metadata
- active conversation id
- system prompt
- conversation context
- recent conversation metadata

The canonical conversation data still comes from Query. Redux here provides convenient, synchronous access to currently relevant metadata.

### 3.3 Projects slice

The `projects` slice stores:

- project list mirror
- selected project
- loading/error

As with conversations, Query remains the main source of fetched project data, while Redux keeps selection and app-level access simple.

### 3.4 UI slice

The `ui` slice sir recent and manages shared UI chrome state, including:

- right bar collapsed state
- right bar width
- notifications

One notable example is branch completion notifications. When a branch stream completes in the background, a notification is added so the user can jump back to it.

---

## 4. TanStack Query structure

`src/hooks/useQueries.ts` acts as Graviton's data access layer.

### Core query groups

#### Projects

- `useProjects()` → `['projects', userId]`
- `useProject(projectId)` → `['projects', projectId]`

#### Conversations

- `useConversations()` → `['conversations']`
- `useConversationsInfinite()` → `['conversations', 'infinite']`
- `useConversationsByProject(projectId)` → `['conversations', 'project', projectId]`
- recent and favorites variants

#### Conversation messages

- `useConversationMessages(conversationId)` → `['conversations', conversationId, 'messages']`

This is a central hook because it returns both:

- flat messages
- tree data used for branching and Heimdall

It also contains logic to resolve `storage_mode` so the app can route correctly between local and cloud backends.

#### Models

- model list queries
- model refresh mutation
- selected model mutation

#### Notes, workspace, and git

- research notes
- directory listing and search
- git overview and diffs
- local git mutations
- global agent data

### Query behavior

The query behavior originally was targetting reduced API calls towards the cloud server, but since local agents have become the main focus, I have been targeting a more instant query cache, for more native app like behavior.

- limited refetch-on-focus behavior
- explicit stale times
- manual invalidation after important mutations
- direct cache updates after local edits

This keeps the UI predictable and reduces unnecessary churn while the user is working inside a long-running chat session.

---

## 5. How Redux and Query work together

Graviton deliberately bridges these systems.

A common pattern looks like this:

1. Fetch canonical data through Query
2. Use Redux to manage the active interaction around that data
3. After a mutation, patch or invalidate Query caches so other screens update immediately

This pattern appears repeatedly across the app.

### Example: conversations and messages

- Query fetches conversation metadata and message trees
- Redux manages the currently selected branch, stream buffers, and optimistic UI state
- after edits, title changes, note updates, branching, or conversation movement, Query caches are updated so the rest of the app remains in sync

This avoids overloading Redux with fetched resource management, while also avoiding unnecessary refetches after every user action.

---

## 6. Chat page (`src/containers/Chat.tsx`)

The chat page is the main orchestration surface in Graviton.

It combines:

- route state
- Redux selectors
- Query hooks
- local component state
- streaming and tool execution flows

### What Redux provides to Chat

Chat reads from Redux for:

- current provider
- current input
- operation mode
- sending state
- active conversation id
- current branch path
- current view stream
- visible messages
- focused message id
- Heimdall state
- optimistic messages
- tool permission state
- IDE context state

This allows the page to react immediately to branching, streaming, editing, tool execution, and graph navigation.

### What Query provides to Chat

Chat uses Query for canonical persisted data such as:

- conversation messages
- conversation storage mode
- project conversations
- models

This gives the page a stable backing dataset while Redux handles the active session runtime.

### Branch-aware streaming

One of the most important design points in Chat is that streaming is branch-aware.

The app maintains multiple streams in Redux and uses selectors to determine which stream belongs to the currently viewed branch. This allows:

- background branch generation
- switching between branches while work continues elsewhere
- separate handling for primary, branch, subagent, and tool streams

The design note in `src/features/chats/chat-streaming-redux-context.md` documents the current streaming model and the transition away from a simpler legacy loading flag.

### Query cache coordination from Chat

Chat also updates shared Query caches when user actions affect global metadata. Examples include:

- updating conversation titles
- updating research notes
- invalidating or pruning message caches when moving between conversations

This keeps Chat, Sidebar, and RightBar aligned without requiring full refetch cycles.

---

## 7. Sidebar (`src/containers/sideBar.tsx`)

The sidebar is the primary navigation surface for:

- projects
- conversations within projects
- favorites
- recents
- project and conversation creation/deletion
- moving conversations between projects

### State profile

The sidebar is more Query-driven than Chat.

It relies on hooks such as:

- `useProjects()`
- `useConversationsByProject(projectId)`
- `useRecentConversations()`
- `useFavoritedConversations()`
- `useMoveConversationToProject()`

These hooks provide the cached list data needed for navigation.

### Where Redux is used in the sidebar

Redux is used for app-level navigation state such as:

- setting the active conversation
- informing the rest of the app which conversation should be treated as current

When a conversation is opened or created, the sidebar coordinates:

- Query cache state
- Redux active selection
- router navigation
- optional `storageMode` passed through route state

That allows the next screen to resolve local-vs-cloud behavior immediately.

### Optimistic cache updates

The sidebar performs direct cache updates for a number of actions:

- deleting projects
- deleting conversations
- toggling favorites
- moving conversations between projects
- creating conversations and reordering projects by activity

This keeps navigation responsive and avoids waiting for a full round-trip before the UI updates.

---

## 8. Settings page (`src/containers/Settings.tsx`)

The settings page is structurally different from Chat and Sidebar.

Much of its state is not fetched application data at all. It is primarily a control surface for:

- localStorage-backed preferences
- Electron-managed configuration
- provider authentication state
- theme, font, and background settings
- tool execution settings
- agent settings
- browser/runtime settings

### State profile

Settings uses a mix of:

- local component state for form controls
- Redux for a small number of runtime-connected concerns
- Query hooks where server-backed or provider-backed data is needed

This is appropriate because Settings behaves more like a control panel than a realtime workflow surface.

### Why most Settings state stays local

Most settings sections are independent form groups. Keeping them in local component state avoids making the global store carry a large amount of low-value form state.

Instead, Settings typically follows this pattern:

- load persisted values from helper storage modules
- edit them locally in the page
- save them back to storage or runtime APIs
- broadcast change events where necessary

That keeps the state model simpler while still allowing the rest of Graviton to react to updates.

---

## 9. Right bar (`src/containers/rightBar.tsx`)

The right bar acts as an integrated workspace pane. It brings together several capabilities that would often be split across separate applications:

- research notes
- Monaco-based file editing
- git diff viewing
- terminal sessions
- embedded browser
- agent activity and queue visibility

### State profile

The right bar uses all three layers heavily:

- local component state
- Redux
- TanStack Query

### Query-backed data in the right bar

The right bar uses hooks for:

- directory file listing and search
- git overview and git diffs
- git actions such as branch checkout/creation and staging
- global agent messages and queued tasks

This lets the pane operate like a lightweight integrated workbench.

### Local state in the right bar

Many right bar concerns are intentionally local, for example:

- which dock tabs are open
- active file editor tabs
- browser tab state
- terminal dock state
- diff tab state
- local scheduling drafts for agents

These concerns are specific to the pane and do not need to be stored globally.

### Shared cache updates from the right bar

The right bar also updates shared Query caches where its actions affect app-wide data.

A clear example is research notes. When a note is saved, the right bar updates:

- `['conversations']`
- `['conversations', 'project', projectId]`
- `['conversations', 'recent']`
- `['research-notes', userId]`

This ensures note changes are immediately reflected across navigation and chat views.

### Agent visibility

The right bar is also where background agent activity becomes visible in the UI. Query-backed hooks expose agent messages, queued tasks, and stream buffers, and the pane formats that into an operational view of currently running work.

---

## 10. Message lifecycle through the app

A typical message flow looks like this:

### Step 1: canonical messages are fetched

`useConversationMessages(conversationId)` retrieves the conversation's persisted messages and tree structure.

### Step 2: Redux establishes the active branch runtime

Redux determines:

- current selected path
- active streams
- optimistic messages
- active tool dialogs
- visible message selection

### Step 3: sending dispatches a chat thunk

A thunk in `chatActions.ts`:

- creates a stream id
- records stream start in Redux
- sends the request to the provider or local server
- consumes stream chunks
- handles tool calls and results
- completes, aborts, or continues the stream loop

### Step 4: selectors derive what the user should see

Selectors in `chatSelectors.ts` compute:

- current visible messages
- current branch stream
- loading state
- Heimdall-related state

### Step 5: shared caches are updated where needed

If the action affects app-wide metadata, Query caches are patched or invalidated so that Sidebar and RightBar stay consistent with the active chat session.

This flow is the core of Graviton's state model.

---

## 11. Local-first runtime considerations

Because Graviton supports both local and cloud-backed data, state resolution includes storage-mode awareness.

### Storage mode awareness

Projects and conversations can exist in:

- local mode
- cloud mode

That affects which backend Graviton should use. Hooks such as `useConversationMessages()` inspect cache state and route accordingly so the UI can resolve quickly, including after navigation or reload.

### Why this matters

This allows the same React application to support:

- local-first desktop usage
- cloud-backed usage
- mixed-mode desktop flows

without maintaining separate frontends.

---

## 12. Summary

Graviton's state model is built around a clear separation:

- **Redux manages the live interaction runtime**
- **TanStack Query manages persisted and fetched resources**

That design works well for an application that combines:

- branching chat
- multi-stream generation
- tool execution
- local workspace integration
- background agents
- integrated navigation and workspace panes

Each major page uses this split differently:

- **Chat** is the core runtime surface, where Redux plays the largest role
- **Sidebar** is a Query-driven navigation surface with optimistic cache updates
- **Settings** is primarily a local configuration surface with selective global integration
- **RightBar** is a mixed workbench surface for notes, code, git, browser, and agent visibility

The result is a state architecture that supports both a responsive UI runtime and a coherent cached data layer across Graviton.

---

## 13. Key files referenced

Core state files:

- `src/store/store.ts`
- `src/features/chats/chatSlice.ts`
- `src/features/chats/chatSelectors.ts`
- `src/features/chats/chatActions.ts`
- `src/hooks/useQueries.ts`

Core page files:

- `src/containers/Chat.tsx`
- `src/containers/sideBar.tsx`
- `src/containers/Settings.tsx`
- `src/containers/rightBar.tsx`

Related design note:

- `src/features/chats/chat-streaming-redux-context.md`
