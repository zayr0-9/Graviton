# Agent Context: Compaction and Memory

Last reviewed: 2026-06-17

## Purpose

Documents context compaction, root-note memory, long-term memory hooks, and related persistence surfaces used to keep agent context useful across long conversations.

## When to Open This File

Use this when changing:
- conversation/context compaction prompts or summaries;
- root-note or long-term-memory hook behavior;
- stop-hook memory extraction;
- note-memory search, storage, or injection into agent context;
- agent context files that refer to compaction or memory workflows.

## Key Files

- `.ygg/hooks/root_note_stop.py`: async Stop hook that updates root-note style conversation memory.
- `.ygg/hooks/long_term_memory_stop.py`: async Stop hook that evaluates whether long-term memory should be updated.
- `client/ygg-chat-r/.ygg/settings.local.json`: bundled hook settings copied into managed user-data hooks.
- `client/ygg-chat-r/electron/hooks/hookRunner.ts`: hook loading, execution, and model feedback handling.
- `client/ygg-chat-r/electron/hooks/hookStorage.ts`: bundled-to-managed hook initialization and settings storage.
- `client/ygg-chat-r/src/features/chats/chatActions.ts`: renderer chat pipeline and compaction call sites.
- `client/ygg-chat-r/src/features/chats/compactionContext.ts`: renderer compaction transcript and bounded tool-context serialization.
- `client/ygg-chat-r/electron/headlessServer/services/compactionService.ts`: headless summary generation, matching bounded tool-context serialization, and summary persistence.
- `docs/agent_context/agent_hooks_system.md`: hook lifecycle and execution-mode context.

## Important Invariants

- Stop-hook memory updates should not block normal chat completion unless explicitly configured as synchronous.
- Hook prompts should judge whether memory is worth updating; avoid writing noisy or duplicate memory.
- Memory hooks should emit stable JSON responses when they need to feed context back to the model.
- Managed hook settings must remain valid JSON because hook discovery parses them on every hook request.
- Agent context indexes should only point to files that exist, or clearly mark unavailable future docs.
- Compaction replaces pre-marker protocol history with a synthetic system summary. Before trimming, completed non-write tool calls are paired to results by call ID and included as a bounded tool-context appendix in both the summarizer prompt and persisted summary.
- Subagent tool results are preserved through the same appendix with a larger per-result allowance; workspace mutation tools retain their specialized exact-arguments appendix.

## Gotchas

- Packaged Electron copies bundled `.ygg` hook resources into the user-data `.ygg` directory. Non-atomic overwrites can make JSON settings briefly unreadable to concurrent hook requests.
- Long-term-memory extraction should treat “no relevant context” as no update, not as content to store.
- Root-note and long-term-memory hooks run from the managed hooks working directory, so relative paths should be written with that runtime cwd in mind.

## Testing and Validation

- Validate hook settings JSON: `python3 -m json.tool client/ygg-chat-r/.ygg/settings.local.json`.
- Build Electron hook code after storage/runner changes: `npm --prefix client/ygg-chat-r run build:electron`.
- Manually trigger several Stop hooks in quick succession and confirm no settings JSON parse warnings appear.
- Run headless compaction/tool-loop tests and verify read-tool and subagent results appear in both the summarizer input and persisted summary.
- Verify this file remains listed in `docs/agent_context/AGENT.md` and exists in `docs/agent_context/`.

## Related Docs

- `agent_hooks_system.md`
- `agent_chat_pipeline.md`
- `agent_project_overview.md`
