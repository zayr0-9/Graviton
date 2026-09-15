---
paths:
  - "docs/graviton_context.md"
---

# Graviton Architecture Context

## Overview

Graviton is a **local-first AI workspace** built around a **branching conversation model**.

In desktop mode, the system is structured as:

- a **React renderer** for the user-facing application
- running inside **Electron**
- backed by an **embedded local Express server**
- with **SQLite** as the local source of truth

That local backend is responsible for much more than persistence. It also handles:

- chat orchestration
- tool execution
- custom HTML apps
- MCP and skills integration
- local workspace operations
- persistent background agent workflows

---

## 1. System structure

### React renderer

The user-facing application lives in `client/ygg-chat-r/src`.

Its responsibilities include:

- chat composition and message rendering
- branch-aware navigation and message selection
- Heimdall graph visualization
- settings and model selection
- rendering HTML app outputs in sandboxed iframes
- coordinating Redux and TanStack Query state

Key files:

- `src/main.tsx`
- `src/App.tsx`
- `src/containers/Chat.tsx`
- `src/components/Heimdall/Heimdall.tsx`
- `src/components/HtmlIframeRegistry/HtmlIframeRegistry.tsx`

### Electron main and preload

Electron provides the desktop boundary.

Its responsibilities include:

- window lifecycle and application shell behavior
- exposing a controlled IPC bridge to the renderer
- starting and stopping the embedded local server
- surfacing privileged desktop capabilities such as filesystem access, shell execution, terminal sessions, secrets, and updater behavior

Key files:

- `electron/main.ts`
- `electron/preload.ts`

### Embedded local server

In desktop mode, the most important backend component is `electron/localServer.ts`.

Graviton runs a **local API and orchestration layer** on localhost. This creates a clean separation between UI concerns and execution concerns.

Its responsibilities include:

- local CRUD routes for projects, conversations, messages, and attachments
- SQLite-backed persistence
- built-in tool execution (`read_file`, `edit_file`, `bash`, `ripgrep`, etc.)
- custom tools, MCP, skills, hooks, and LSP endpoints
- local workspace and git-related routes
- headless and mobile/LAN routes
- background agent and orchestration endpoints

Key file:

- `electron/localServer.ts`

This local server is one of the central architectural decisions in the project because it provides a internal control plane that can be reused by multiple interfaces.

---

## 2. Persistence model

In local mode, Graviton stores application data in SQLite.

Core entities include:

- users
- projects
- conversations
- messages
- attachments and attachment links
- provider usage/cost data
- HTML tool state
- agent settings, sessions, tasks, and summaries

The most important modeling choice is that **messages are stored as a tree rather than a flat transcript**.

Key fields:

- `messages.parent_id`
- `messages.children_ids`

This supports:

- branch-aware conversation history
- non-linear navigation
- replay of message paths
- graph rendering in Heimdall
- preserving alternative lines of reasoning without overwriting prior work

That storage model is directly reflected in the UI and is not just an implementation detail.

---

## 3. Chat orchestration model

The main chat orchestration logic lives in:

- `src/features/chats/chatActions.ts`

This layer is responsible for:

- sending messages
- branching from existing messages
- editing with branching semantics
- streaming provider responses
- handling tool calls and tool results
- continuing multi-turn tool loops
- managing branch compaction when context grows large

This is crucial for the agent to work and provides state to the stateless api.

### Typical local chat flow

A typical desktop/local turn looks like this:

1. A message is submitted from `Chat.tsx`
2. The chat orchestration layer builds the correct branch-aware message history
3. The request is routed to the appropriate backend path
4. In local mode, the embedded local server receives the request
5. A provider response streams back incrementally
6. If the model emits tool calls, the local tool runtime executes them
7. Tool results are inserted back into the turn history
8. The loop continues until the model stops calling tools
9. Results are persisted and reflected back into UI state

That same execution model is reused for:

- regular chat turns
- branch generation
- subagent workflows
- persistent background agent execution

Features are layered onto the same core orchestration stack rather than implemented as isolated one-off systems.

---

## 4. Branching as a first-class model

A defining characteristic of Graviton is that branching is a first-class product and persistence concept.

In many chat interfaces, branching is mainly a UI affordance. In Graviton, it is built into:

- the message storage model
- the current-path selection model
- the streaming system
- the graph visualization layer
- message editing and replay behavior

The Heimdall graph makes that model visible to the user, but the important point is that the graph reflects the actual underlying message structure.

This approach provides several benefits:

- preserves alternative solution paths
- avoids destroying prior context when exploring a new direction
- reduces context pollution and cost by keeping branches isolated

The tradeoff is increased complexity in:

- path selection
- deletion semantics
- rendering and interaction logic
- stream-to-branch association

That complexity is intentional because the product is designed around exploration rather than a single linear transcript.

---

## 5. State management approach

Graviton uses two complementary state systems.

### Redux

Redux manages **interactive runtime state**, especially where immediate UI responsiveness matters.

This includes:

- chat composition state
- active stream state
- current branch path
- Heimdall state
- optimistic messages
- tool permission requests
- selected conversation/runtime focus
- UI chrome such as right bar behavior

### TanStack Query

TanStack Query manages **fetched and persisted resource data**.

This includes:

- projects
- conversations
- conversation messages and tree payloads
- notes
- models
- workspace and git data
- background agent data

The practical split is:

- **Redux for live runtime behavior**
- **TanStack Query for cached resource state**

The separation works well with Graviton which combines streaming UI, persistent data, and local orchestration.

---

## 6. HTML app runtime

Graviton supports tools that return HTML instead of plain text.

Those outputs are rendered as sandboxed iframe-based apps inside the interface. They can appear inline in chat or in a dedicated registry/modal surface.

Core files:

- `src/components/HtmlIframeRegistry/HtmlIframeRegistry.tsx`
- `src/utils/iframeBridge.ts`
- `electron/localToolsRoutes.ts`

This subsystem provides:

- persistence for HTML app state
- lifecycle management for iframe instances
- a permission-gated host bridge via `postMessage`
- a path for richer tool UIs than plain text tool output allows

This is a novel part of the product architecture because it extends the system beyond chat into persistent, stateful mini-apps.

## 10. Key implementation files

If a concise set of files is needed to understand the system, the most representative ones are:

1. `electron/localServer.ts`
2. `src/features/chats/chatActions.ts`
3. `src/components/Heimdall/Heimdall.tsx`
4. `src/components/HtmlIframeRegistry/HtmlIframeRegistry.tsx`
5. `src/services/GlobalAgentLoop.ts`

Together, these cover:

- local orchestration and persistence
- chat and tool execution flow
- branching UX and graph rendering
- HTML app runtime
- persistent background agent execution
