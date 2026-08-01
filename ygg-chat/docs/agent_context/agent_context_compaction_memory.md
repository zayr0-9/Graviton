# Agent Context: Compaction and Memory

Last reviewed: 2026-08-01

## Purpose

Documents context compaction, root-note memory, long-term memory hooks, and related persistence surfaces used to keep agent context useful across long conversations.

Scope note: after the headless thin-client migration, the MAIN chat agent loop (and its in-loop auto-compaction) runs SERVER-SIDE in the local headless Express server (`127.0.0.1:3002`, inside the Electron main process). This doc is Electron-only; web mode is not a target.

## When to Open This File

Use this when changing:
- conversation/context compaction prompts, summaries, or the in-loop compaction trigger;
- root-note or long-term-memory hook behavior;
- stop-hook memory extraction;
- note-memory search, storage, or injection into agent context;
- server-side context/token estimation used to decide when to compact;
- agent context files that refer to compaction or memory workflows.

## Where compaction runs (post-migration)

- IN-LOOP (auto) compaction is SERVER-OWNED. It fires inside the tool loop, not the renderer. `client/ygg-chat-r/electron/headlessServer/services/toolLoopService.ts` `ToolLoopService.run` evaluates compaction at a quiescent turn boundary (every requested tool has executed once and its result is durable) — the block at `toolLoopService.ts:939-1001`. When it decides to compact it calls `this.compactBranch(...)`, which `ChatOrchestrator` wires to `CompactionService.compactBranch` (`client/ygg-chat-r/electron/headlessServer/index.ts` builds `CompactionService` and passes `compactBranch: input => compactionService.compactBranch(input)`).
- MANUAL compaction (the UI "compact" button) is STILL RENDERER-SIDE. The `compactBranch` thunk in `client/ygg-chat-r/src/features/chats/chatActions.ts` (`chat/compactBranch`) streams a summary directly per-provider (client-side ephemeral request) and dispatches `compactingStarted`. This is the one surviving renderer generation path. A server route `POST /api/conversations/:id/compact` (`client/ygg-chat-r/electron/headlessServer/routes/chatRoutes.ts`) also exists and calls `compactionService.compactBranch`, but the manual button uses the renderer thunk, not this route.
- The renderer also keeps a PRE-BRANCH auto-compaction precheck inside `editMessageWithBranching` (`chatActions.ts`): if branch context ≥85%, it dispatches the same client-side `compactBranch` thunk before sending the branch. This reuses the manual path; it is not the in-loop server compaction.
- The renderer no longer imports `resolveOpenAIContinuationCompaction` or otherwise orchestrates in-loop compaction (grep-confirmed: zero hits in `src`).

## Server-side context/token estimation

The in-loop compaction decision is computed server-side:
- `shared/contextUsage.ts` (repo root, imported by the server loop): `resolveOpenAIContinuationCompaction`, `openAIModelContextLength`, `extractOpenAIContextUsageFromBlocks`, `shouldCompactAtPercent`, `isOpenAIProvider`.
- In `toolLoopService.ts`: `projectedReplayTokens` (char/4 heuristic over system prompt + conversation/project context + full history) and `usageFromMessage` (reads provider-reported `context_usage` or extracts it from content blocks).
- Decision (`resolveOpenAIContinuationCompaction`): `effectiveTokens = max(reportedTokens, projectedTokens)`; compact iff `enabled !== false` AND `isOpenAIProvider(provider)` AND `contextLength > 0` AND `effectiveTokens ≥ thresholdPercent% of contextLength` (default `thresholdPercent = 85`). So in-loop auto-compaction only fires for the OpenAI-family provider route.
- Compaction knobs travel on the request contract (`electron/headlessServer/contracts/headlessApi.ts`: `autoCompactionEnabled`, `contextLength`, `compactionThresholdPercent`, `compactionProvider`, `compactionModelName`, `compactionSystemPrompt`) and are threaded through `ChatOrchestrator` into `ToolLoopRunInput`. The renderer's `buildServerLoopRequest` does NOT set them, so the server defaults apply (`autoCompactionEnabled ?? true`, `contextLength ?? openAIModelContextLength(modelName)`, threshold default 85, compaction provider/model fall back to the turn's provider/model). Net: in-loop auto-compaction is server-defaulted ON.
- Estimation is validated by `client/ygg-chat-r/electron/headlessServer/providers/__tests__/contextTokenEstimate.test.ts`, which exercises `estimateContentBlocksForContext` (image-payload redaction) and `openAIContextUsageHistory` (ordered branch snapshots, dedup of duplicate provider response IDs) from `client/ygg-chat-r/src/features/chats/contextTokenEstimate.ts`.

## Key Files

- `client/ygg-chat-r/.ygg/hooks/root_note_stop.py`: async Stop hook that updates root-note style conversation memory.
- `client/ygg-chat-r/.ygg/hooks/long_term_memory_stop.py`: async Stop hook that evaluates whether long-term memory should be updated.
- `client/ygg-chat-r/.ygg/settings.local.json`: bundled hook settings copied into managed user-data hooks.
- `client/ygg-chat-r/electron/hooks/hookRunner.ts`: hook loading, execution, and model feedback handling; now invoked IN-PROCESS by the server loop (wired as `hookRunner: runHookRequest` in `electron/headlessServer/index.ts`).
- `client/ygg-chat-r/electron/hooks/hookStorage.ts`: bundled-to-managed hook initialization and settings storage.
- `client/ygg-chat-r/electron/headlessServer/services/chatHookService.ts`: runs Ygg hooks in-process at the loop's lifecycle points (incl. the Stop point, `runStop`, that fires the memory Stop hooks). Header documents that memory-context injection is intentionally NOT ported to the server loop.
- `client/ygg-chat-r/electron/headlessServer/services/toolLoopService.ts`: server chat/tool loop; owns the in-loop auto-compaction trigger (`ToolLoopService.run`, block `:939-1001`) and the server-side token projection (`projectedReplayTokens`, `usageFromMessage`).
- `client/ygg-chat-r/electron/headlessServer/services/compactionService.ts`: `CompactionService` — headless summary generation (`generateCompactionSummary`, `:503`), bounded tool-context / write-op serialization, and summary persistence (`compactBranch`, `:559`). `AUTO_COMPACTION_NOTE = '__auto_compaction_summary__'` marker + resume-line prefix (`ensureCompactionSummaryResumeLine`).
- `client/ygg-chat-r/electron/headlessServer/services/chatOrchestrator.ts`: wires `compactBranch` to `CompactionService.compactBranch` and threads the compaction knobs into `ToolLoopRunInput`.
- `client/ygg-chat-r/electron/headlessServer/index.ts`: constructs `CompactionService` and the `ChatOrchestrator`; registers chat routes with the compaction service.
- `client/ygg-chat-r/electron/headlessServer/routes/chatRoutes.ts`: `POST /api/conversations/:id/compact` manual-compaction route → `compactionService.compactBranch`.
- `shared/contextUsage.ts`: server-side compaction/token decision helpers (`resolveOpenAIContinuationCompaction`, `openAIModelContextLength`, `extractOpenAIContextUsageFromBlocks`, `shouldCompactAtPercent`, `isOpenAIProvider`).
- `client/ygg-chat-r/src/features/chats/contextTokenEstimate.ts`: token/content-block estimation helpers (`estimateContentBlocksForContext`, `openAIContextUsageHistory`, `safeEstimateTokenCount`); validated by the server-side test above and used by the renderer for its pre-branch token precheck.
- `client/ygg-chat-r/src/features/chats/chatActions.ts`: thin-client chat pipeline. Its only compaction call site is the manual `compactBranch` thunk (plus the pre-branch precheck that dispatches it); the in-loop loop no longer lives here.
- `client/ygg-chat-r/src/features/chats/compactionContext.ts`: renderer compaction transcript and bounded tool-context serialization used by the manual `compactBranch` thunk; mirrors the server's `compactionService` serialization.
- `docs/agent_context/agent_hooks_system.md`: hook lifecycle and execution-mode context.

## Important Invariants

- In-loop auto-compaction runs server-side inside `ToolLoopService.run` at a quiescent turn boundary; the renderer no longer orchestrates it. Missing `compactBranch` or a compaction failure emits `context_compaction { status: 'failed' }` and throws (run finishes with `endReason: context_compaction_failed`).
- In-loop auto-compaction fires only for the OpenAI-family provider route (`isOpenAIProvider`) and only when `effectiveTokens ≥ thresholdPercent%` of `contextLength`; it is server-defaulted ON because the renderer does not send the compaction knobs.
- On a successful in-loop compaction the loop validates the persisted marker (`role: 'system'`, `note: '__auto_compaction_summary__'`, `parent_id === assistantMessage.id`), resets `history = [summaryMessage]`, and emits `context_compaction { status: 'completed', summaryMessage }`.
- Compaction replaces pre-marker protocol history with a synthetic system summary. Before trimming, completed non-write tool calls are paired to results by call ID and included as a bounded tool-context appendix in both the summarizer prompt and persisted summary.
- Subagent tool results are preserved through the same appendix with a larger per-result allowance (`MAX_SUBAGENT_RESULT_CHARS`); workspace mutation tools (`edit_file`, `multi_edit`, `create_file`, `delete_file`) retain their specialized exact-arguments appendix.
- Stop-hook memory updates now fire via the server loop's Stop lifecycle point (`chatHookService.runStop` → `hookRunner.runHookRequest`), not the renderer. They should not block normal chat completion unless explicitly configured as synchronous.
- Hook prompts should judge whether memory is worth updating; avoid writing noisy or duplicate memory.
- Memory hooks should emit stable JSON responses when they need to feed context back to the model.
- Managed hook settings must remain valid JSON because hook discovery parses them on every hook request.
- Agent context indexes should only point to files that exist, or clearly mark unavailable future docs.

## Gotchas

- Memory-context INJECTION (long-term/recent/project memory folded into the inference prompt) is intentionally NOT ported to the server loop (see the `chatHookService.ts` header). The renderer still loads memory contexts (`maybeLoadMemoryContexts` in `chatActions.ts`) but currently only to estimate tokens for its pre-branch compaction precheck — it is not folded into the server-assembled system prompt. Only hook `additionalContext` is folded server-side.
- Two compaction entry points share the same serialization but diverge in ownership: server in-loop (`toolLoopService.ts` → `CompactionService.compactBranch`) vs renderer manual button (client-side `compactBranch` thunk). A serialization change must be mirrored in both `compactionService.ts` and `compactionContext.ts` to keep summaries identical.
- Packaged Electron copies bundled `.ygg` hook resources into the user-data `.ygg` directory. Non-atomic overwrites can make JSON settings briefly unreadable to concurrent hook requests.
- Long-term-memory extraction should treat “no relevant context” as no update, not as content to store.
- Root-note and long-term-memory hooks run from the managed hooks working directory, so relative paths should be written with that runtime cwd in mind.

## Testing and Validation

- Validate hook settings JSON: `python3 -m json.tool client/ygg-chat-r/.ygg/settings.local.json`.
- Build Electron/server code after storage/runner/loop changes: `npm --prefix client/ygg-chat-r run build:electron`.
- Manually trigger several Stop hooks in quick succession and confirm no settings JSON parse warnings appear.
- Run the server-side context/token estimation test: it validates image-payload redaction and context-usage ordering used by the compaction decision (`client/ygg-chat-r/electron/headlessServer/providers/__tests__/contextTokenEstimate.test.ts`).
- Run headless compaction/tool-loop tests and verify read-tool and subagent results appear in both the summarizer input and persisted summary.
- Verify this file remains listed in `docs/agent_context/AGENT.md` and exists in `docs/agent_context/`.

## Related Docs

- `agent_hooks_system.md`
- `agent_chat_pipeline.md`
- `agent_project_overview.md`
