# Agent Context: Hooks System

Last reviewed: 2026-08-01

## Purpose

Documents Ygg hook lifecycle, hook loading/storage, sync/async execution, and how hook output feeds back into the chat/tool loop.

Post headless-thin-client migration, the **main chat loop runs hooks server-side, in-process** inside the Electron main process (no HTTP round-trip). The renderer is a thin client: it only opts in by setting `hooksEnabled` on its POST to the server-owned loop; it no longer runs any hook. The `hookRunner` command-execution/output-parsing engine is unchanged and still authoritative.

## When to Open This File

Use this when changing:
- hook event payloads or response contracts;
- sync vs async hook execution;
- hook storage/discovery;
- server-loop integration of UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure, or Stop;
- hook settings format;
- the PreToolUse deny/rewrite gate relative to the permission prompt.

## Key Files

### Hook engine (unchanged by the migration)
- `client/ygg-chat-r/docs/hookInstruction.md`: detailed user-facing hook instructions.
- `client/ygg-chat-r/electron/hooks/hookTypes.ts`: hook types/contracts (`HookRunRequest`, `HookRunResult`, `HookEventName`, execution-mode types).
- `client/ygg-chat-r/electron/hooks/hookRunner.ts`: `runHookRequest` — discovery, matcher filtering, sync/async dispatch, command execution, and output parsing. This is the single hook-execution entry point for both the settings UI and the server loop.
- `client/ygg-chat-r/electron/hooks/hookManager.ts`: hook discovery/management (settings UI).
- `client/ygg-chat-r/electron/hooks/hookStorage.ts`: settings/load helpers + `ensureManagedHooksInitialized`.
- `.ygg/settings.json` and `.ygg/settings.local.json`: hook config locations discovered by `hookRunner` (in addition to the managed hooks dir).

### Server-loop integration (this is where the chat loop fires hooks)
- `client/ygg-chat-r/electron/headlessServer/services/chatHookService.ts`: `createChatHookSession` — the per-run session that wraps `runHookRequest`, rebuilds lineage/metadata from `ConversationRepo`, accumulates `additionalContext`, and exposes the 5 lifecycle calls + the `ToolLoopHooks` adapter. Pure builders (`buildHookLineage`, `buildHookMetadata`, `buildSystemPromptWithHookContext`, `appendHookAdditionalContext`) are verbatim ports of the old renderer functions.
- `client/ygg-chat-r/electron/headlessServer/services/chatOrchestrator.ts`: builds the hook session (`ChatOrchestrator.runMessage`, `chatOrchestrator.ts:314`), fires `UserPromptSubmit` (`:339`), and interleaves Pre/Post/Failure hooks inside the pausing tool executor (`createChatPausingExecutor`, `:95`).
- `client/ygg-chat-r/electron/headlessServer/services/toolLoopService.ts`: consumes `input.hooks` (`ToolLoopHooks`, `toolLoopService.ts:77`) — folds hook context into each turn's system prompt then clears it (`:649-651`), and calls `runStop` on a natural stop (`:726-727`).
- `client/ygg-chat-r/electron/headlessServer/index.ts:319`: wires `hookRunner: runHookRequest` (in-process) into the `ChatOrchestrator`.

### Renderer (thin-client) surface
- `client/ygg-chat-r/src/features/chats/chatActions.ts`: the 3 chat thunks set `hooksEnabled: isElectronMode` on the server-loop request (`chatActions.ts:1258`, `:1788`, `:1998`). They no longer contain any hook call site.
- `client/ygg-chat-r/src/features/chats/chatHookClient.ts`: **legacy for the chat loop** — its `runChatHook` (`POST /hooks/run`) is no longer on the main loop; only its `ChatHookProjectContext` type is still imported by `chatActions.ts`. The old `/api/hooks/run` route (`electron/localServer.ts`) survives but is off the main chat path; `/api/hooks` + `/api/hooks/toggle` remain for the settings UI.

## Lifecycle Events

All five fire from the **server-owned loop, in-process**, only when the run opted in (see Gating below). Lineage/metadata for every payload is rebuilt per-call from `ConversationRepo.listMessages` (`chatHookService.ts` `buildHookMetadata`/`buildHookLineage`), not from renderer state.

- `UserPromptSubmit` (`chatHookService.ts:246`, called at `chatOrchestrator.ts:339`): fires **before the user message is persisted**, for `send`/`branch`/`edit-branch` only (not `repeat`). Can rewrite `request.content` (the rewrite flows into both the persisted user row and the inference content) or block (throw → run finishes `error`). Carries project context.
- `PreToolUse` (`chatHookService.ts:270`, called at `chatOrchestrator.ts:153`): fires **BEFORE any permission prompt or plan_md clarify**. `updatedInput` rewrites the effective tool arguments (the permission prompt then shows the rewritten args; `toolCallId` is unchanged); `permissionDecision === 'deny'` throws → surfaces as an `is_error` tool_result. No project context.
- `PostToolUse` (`chatHookService.ts:290`, called at `chatOrchestrator.ts:177`): success path, after tool execution. Payload `tool_result` = `toToolResultContent(result)`. Fires even for the clarify path.
- `PostToolUseFailure` (`chatHookService.ts:312`, called at `chatOrchestrator.ts:184`): error path. Fires on both a PreToolUse deny and a permission deny (single try/catch). **Does NOT fire on abort** — aborts rethrow unwrapped (`chatOrchestrator.ts:183`), a deliberate divergence from the renderer's fire-on-any-error behavior.
- `Stop` (`chatHookService.ts:335`, called by the loop at `toolLoopService.ts:726-727` via `input.hooks.runStop`): fires on a would-be natural stop (no tool calls). `blocked === true` → force one more turn — the loop injects an empty user turn parented on the just-persisted assistant message and appends the reason to the hook-context buffer. No-op without hooks.

`additionalContext` from every event accumulates into a shared `hookContext[]` buffer (`appendHookAdditionalContext`). Each turn the loop calls `foldSystemPrompt(base)` → appends one `[Hook context]` block per accumulated entry after the base prompt, then **clears the buffer** (`toolLoopService.ts:649-651`). A hooks-enabled run with no hook output is byte-for-byte identical to the non-hooks path.

## Gating

The hook session is built only when **all three** hold (`chatOrchestrator.ts:314`): a `hookRunner` is wired, the request set `hooksEnabled === true`, AND a `DecisionBroker` exists (hooks live on the pausing executor, which requires the broker). Subagents, the mobile LAN UI, and tests never enable it → their loop is byte-for-byte unchanged. The renderer sets `hooksEnabled: isElectronMode`, so hooks run only in Electron.

Wiring: the executor Pre/Post/Failure hooks are interleaved inside `createChatPausingExecutor` when a `hookSession` is passed; the loop side receives `hookSession.toolLoopHooks()` → `{ hookContext, foldSystemPrompt, runStop }` as `input.hooks` (`chatOrchestrator.ts:472`).

**Not ported (intentional):** memory-context injection (long-term/recent/project memory) that the old renderer folded via the same helper is a separate feature and is deliberately NOT reproduced server-side; only hook context is folded.

## Execution Mode Notes

(These are hook-engine behaviors in `hookRunner.ts`, unchanged by the migration.)

- Some hook types must be synchronous because they make decisions or mutate prompt/tool input. `getDefaultExecutionMode` (`hookRunner.ts:114`): `UserPromptSubmit` and `PreToolUse` default `sync`; the rest default `async`.
- `PreToolUse` is security/permission-sensitive and is **forced synchronous** even if misconfigured (`resolveExecutionMode`, `hookRunner.ts:120`).
- Async hooks are fire-and-forget: their output is logged but cannot affect the current request.
- Tool/prompt-mutating hooks should default to awaited/synchronous unless intentionally changed.
- `PreToolUse` can observe/rewrite edit tool inputs; managed file-edit undo backups are captured by the local tool runtime after hook rewriting and before `edit_file`/`multi_edit` execution.

## Important Invariants

- The renderer never executes hook commands; the **server-owned chat loop** runs them in-process (same Electron main process, no HTTP). The renderer only sets `hooksEnabled` on its POST to the loop.
- Hook commands receive JSON via stdin (`buildHookPayload`, `hookRunner.ts:354`); payload keys are snake_case.
- Prefer JSON output from hooks for stable parsing; text output falls back to `interpretTextResult` (`hookRunner.ts:414`).
- `additionalContext` is model feedback folded into the system prompt as a `[Hook context]` block, not a user message.
- Deny/block decisions should produce explicit reasons; a PreToolUse deny reason surfaces in the thrown error / `is_error` tool_result.
- PreToolUse runs (and can deny/rewrite) **before** the interactive permission prompt — the prompt reflects any rewritten arguments.

## Gotchas

- Hook discovery (`collectYggSettingsFiles`, `hookRunner.ts:254`) checks the managed hooks dir first; if none, it walks upward from the active cwd and from user home for `.ygg/settings.json` + `settings.local.json`. cwd bugs can make hooks appear missing.
- WSL/Windows path handling affects settings discovery and command execution.
- Matchers apply only to `PreToolUse`/`PostToolUse`/`PostToolUseFailure`, matched against the tool name (`matchesHookMatcher`, `hookRunner.ts:173`); other events ignore matchers.
- Errors from one sync hook are collected into `result.errors` while later hooks continue — check returned `errors`.
- A hook-runner rejection is swallowed into a no-match result in `chatHookService` (`safeRun`) so a hook failure never aborts the chat.
- Set `YGG_HOOK_DEBUG_LOGS=1` for verbose `[HookRunner]` tracing.

## Testing and Validation

- Build Electron after contract changes: `npm --prefix client/ygg-chat-r run build:electron`.
- Server-loop hook unit tests: `client/ygg-chat-r/electron/headlessServer/services/__tests__/chatHookService.test.ts`.
- Manually verify a simple command hook for each touched event.
- For chat integration changes, test send, tool use, failed tool use, PreToolUse deny/rewrite before the permission prompt, and Stop continuation.

## Related Docs

- `agent_chat_pipeline.md`
- `agent_local_tools_runtime.md`
- `client/ygg-chat-r/docs/hookInstruction.md`
