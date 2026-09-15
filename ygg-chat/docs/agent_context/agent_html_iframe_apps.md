---
paths:
  - "client/ygg-chat-r/src/components/HtmlIframeRegistry/**"
  - "client/ygg-chat-r/src/utils/iframeBridge.ts"
  - "client/ygg-chat-r/src/components/ChatMessage/HtmlIframe.tsx"
  - "client/ygg-chat-r/src/components/HtmlToolsModal/**"
  - "client/ygg-chat-r/src/components/HtmlToolsModalFullScreen/**"
  - "client/ygg-chat-r/server/localToolsRoutes.ts"
---

# Agent Context: HTML Iframe Apps

Last reviewed: 2026-06-16

## Purpose

Documents custom tool HTML UI rendering, iframe lifecycle/cache, host bridge IPC, and permission-gated persistent-agent access.

## When to Open This File

Use this when changing:
- inline HTML tool rendering;
- `HtmlIframeRegistry` lifecycle/caching;
- iframe bridge APIs;
- custom app permissions;
- `html_tools` persistence;
- agent read/write access from iframe apps.

## Key Files

- `html_frame_context.md`: deep existing context doc.
- `client/ygg-chat-r/src/components/HtmlIframeRegistry/HtmlIframeRegistry.tsx`: registry, caching, hibernation, positioning.
- `client/ygg-chat-r/src/utils/iframeBridge.ts`: postMessage bridge and permission enforcement.
- `client/ygg-chat-r/src/components/ChatMessage/HtmlIframe.tsx`: inline iframe rendering.
- `client/ygg-chat-r/src/components/ChatMessage/ChatMessage.tsx`: tool result detection/rendering.
- `client/ygg-chat-r/src/components/HtmlToolsModal/HtmlToolsModal.tsx`: modal surface.
- `client/ygg-chat-r/src/components/HtmlToolsModalFullScreen/HtmlToolsModalFullScreen.tsx`: full-screen surface.
- `client/ygg-chat-r/electron/localToolsRoutes.ts`: local SQLite CRUD for HTML tool entries.
- `client/ygg-chat-r/electron/tools/customToolLoader.ts`: preserves custom tool `appPermissions`.

## Data Flow

1. A custom tool returns HTML directly or as `type: "text/html"`.
2. Chat inline renderer or registry modal creates iframe entry.
3. Registry persists/cache metadata including `toolName` where available.
4. Iframe sends `postMessage` requests to host bridge.
5. Host bridge resolves iframe `toolName`, checks custom tool definition and `appPermissions`, and performs allowed actions.

## Important Invariants

- Iframes are untrusted UI; host-side permission enforcement is mandatory.
- `toolName` must be preserved for permission checks.
- `appPermissions.agent` controls agent read/write access.
- Cached old entries may lack new metadata; debugging should include cache eviction/re-render.
- Do not add host bridge methods that bypass permission gates.

## Testing and Validation

- Build web/electron target after bridge/type changes.
- Manual verify inline iframe, registry modal, persistence reload, hibernation/favorite behaviour, and permission denied/allowed cases.
- Custom tool loader changes: `npm --prefix client/ygg-chat-r run test:tools`.

## Related Docs

- `agent_custom_tools.md`
- `agent_global_persistent_agent.md`
- `html_frame_context.md`
