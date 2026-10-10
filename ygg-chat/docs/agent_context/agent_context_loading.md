---
paths:
  - "client/ygg-chat-r/server/context/**"
  - "shared/contextInjection.ts"
  - "shared/contextDirectories.ts"
  - "shared/toolNameAliases.ts"
  - "client/ygg-chat-r/src/helpers/contextDirectorySettingsStorage.ts"
  - "client/ygg-chat-r/src/components/ChatMessage/ContextInjectionCard.tsx"
---

# Agent Context: Auto-loaded Instruction Files, Rules, Skills, Agents

Last reviewed: 2026-09-15

Graviton implements repository-context loading inspired by the dated Claude Code
reference in `../claude_code_context_loading_rules.md`, with the limitations below.
This describes current Graviton source, not live upstream parity.

## Entry files

| Area | File |
| --- | --- |
| Per-conversation orchestration | `client/ygg-chat-r/server/context/contextLoader.ts` (`ConversationContextLoader`) |
| AGENTS.md / CLAUDE.md chain, `@path` imports, dedupe, labels | `server/context/instructionFiles.ts` |
| `<configDir>/rules/**/*.md`, `paths` frontmatter | `server/context/rulesLoader.ts` |
| Glob semantics (`**`, `*`, `{a,b}` budget, `[abc]`, root anchoring) | `server/context/globMatcher.ts` |
| Frontmatter envelope, booleans, lists, HTML comment stripping | `server/context/frontmatter.ts` |
| SKILL.md discovery, index, `$ARGUMENTS` rendering, `/name` matching | `server/context/skillsDiscovery.ts` |
| `<configDir>/agents/**/*.md` definitions, validation, index | `server/context/agentsLoader.ts` |
| `MEMORY.md` head read (200 lines / 25 KB), project slug, memory prompt | `server/context/autoMemory.ts` |
| conversationId → loader handle (for `skill_manager`, subagents) | `server/context/contextSessionRegistry.ts` |
| Persisted shapes + model fold | `shared/contextInjection.ts` |
| Directory setting shape, presets, env defaults | `shared/contextDirectories.ts` |
| Claude Code → Graviton tool name aliases | `shared/toolNameAliases.ts` |

## Where it plugs in

- `server/headlessServer/services/chatOrchestrator.ts`: builds the loader when the
  conversation has a root, registers it, builds the launch injection, adds the skill /
  agent / memory parts to the system prompt, and passes `contextLoader`,
  `persistContextInjection`, `contextDirectories` and `hookContextPlacement: 'transcript'`
  to the loop.
- `server/headlessServer/services/toolLoopService.ts`: after each tool call collects
  hook `additionalContext`, the `skill_manager activate` body, and lazy loads into
  `context_injection` blocks beside the `tool_result`; folds them into model text in
  `generateProviderTurn`; re-injects the launch set and invoked skills after compaction.
- `server/headlessServer/services/subagentToolExecutor.ts`: `agent_type` argument → agent
  body as system prompt, `tools` / `disallowedTools`, `skills` preload, agent memory,
  instruction files unless `omitClaudeMd`.
- `server/skills/skillManager.ts`: `list` / `activate` / `load_resource` resolve project
  and user-scope skills through the registry first, host installs second.
- Renderer: `src/helpers/contextDirectorySettingsStorage.ts` (localStorage
  `chat:contextDirectories`), Settings section "Context files" in
  `src/containers/Settings.tsx`, request fields in `src/features/chats/buildServerLoopRequest.ts`,
  the visible card `src/components/ChatMessage/ContextInjectionCard.tsx` used by
  `src/containers/Chat.tsx` (launch row) and `src/components/ChatMessage/ChatMessage.tsx` (blocks),
  Heimdall filter button in `src/components/Heimdall/Heimdall.tsx`.

## Data flow

1. Request carries `rootPath`, `contextDirectories` (`{ readDirs, writeDir }`) and
   `autoMemoryEnabled`. Missing setting → `YGG_CONTEXT_DIRECTORIES` /
   `YGG_CONTEXT_WRITE_DIRECTORY`, then `['.ygg', '.claude']` / `.ygg`.
2. Launch set (once per branch): user scope `~/<readDir>/AGENTS.md`, `~/<readDir>/CLAUDE.md`
   → ancestor chain from the filesystem root to `rootPath` (`AGENTS.md`, `CLAUDE.md` or
   `.claude/CLAUDE.md`, `AGENTS.local.md`, `CLAUDE.local.md`) → `@path` imports (4 hops)
   → unconditional rules (user then project) → `MEMORY.md`. Rendered as one
   `<system-reminder>` and persisted as a **user row** with
   `meta = { kind: 'context_injection', files, reason }`, parented on the previous
   message; the user's own message is parented on it.
3. Lazy loads: a `read_file` / `read_files` / `read_file_continuation` / `edit_file` /
   `multi_edit` / `create_file` call on a path below the root triggers nested instruction
   files, matching path-scoped rules, matching path-scoped skills, and nested skill
   discovery. Each becomes a `context_injection` block (`tool_use_id`, `path`, `label`,
   `text`, `reason`) on the assistant row.
4. Already-loaded set = `collectLoadedContextPaths(history after latest compaction)`.
   Derived per request from the active branch, never a global set.
5. Compaction: `buildPostCompactionInjection` re-reads instruction files and `MEMORY.md`,
   reuses the loader's cached unconditional rules, and re-attaches recorded skill
   bodies within character budgets (≈5,000 tokens each, ≈25,000 total) as a context
   row under the summary; `context_injection_persisted` SSE event.
   Re-attached skills become rendered launch-row text, not `reason: 'skill'` blocks,
   so a second compaction cannot collect them unless invoked again. Selection uses
   map insertion order; re-invocation updates the body without refreshing order.
6. Hooks: `additionalContext` from UserPromptSubmit / SessionStart rides on the user row;
   from PreToolUse / PostToolUse / PostToolUseFailure on the tool result; from Stop on the
   next user turn. `foldSystemPrompt` remains only behind
   `hookContextPlacement: 'system_prompt'` (default off).

## Markdown memory

- Auto-memory has one source: `<dataDir>/.ygg/memory/projects/<cwd-or-git-root-slug>/MEMORY.md`, unless `autoMemoryDirectory` or the memory environment overrides select another directory. Sidebar project names/IDs do not select memory.
- Only the first 200 lines / 25 KB of the index are injected. Individual fact files beside it are read on demand with normal file tools; those tools also write/update facts and the index.
- A missing index contributes no memory entry. The system memory prompt still supplies the exact directory where the agent can create it. Memory from a parent workspace is not inherited automatically.
- The legacy aggregate-memory APIs, `memory_manage` tool, file browser, and long-term-memory Stop writer are removed. Old memory files are preserved but not auto-loaded. Review/migrate useful facts to the selected directory and link them from its index. Explicit `autoMemoryDirectory` settings can share memory across repositories.
- Note-summary search, embeddings, and the root-note Stop hook are separate from auto-memory and remain supported.

## Invariants

- The system prompt is built once per run and never changes between iterations
  (provider prefix cache). Skill / agent indexes and the memory prompt are part of it and
  are pure functions of root + settings.
- Providers never see `context_injection` blocks or `meta`; `foldContextInjectionsForModel`
  runs in `generateProviderTurn` on every history array.
- `model:` / `effort:` in skills and agents are ignored (decision 12). Dynamic skill
  shell injection (`` !`cmd` ``) and skill `allowed-tools` / `disallowed-tools`
  enforcement are not implemented.
- Settings-based lifecycle command hooks **are implemented** by `server/hooks/hookRunner.ts`
  and `chatHookService.ts`. Discovery prefers readable managed hook settings; only when
  none exist does it walk cwd/home ancestor chains for `.ygg/settings.json` and
  `.ygg/settings.local.json`. It does not merge these with the context `readDirs` setting.
  Chat execution requires a wired hook runner, `hooksEnabled: true`, and a decision broker.
- Skill-scoped frontmatter `hooks:` are a separate mechanism: `parseSkillFrontmatter`
  retains the field, but skill activation does not register or execute it. A skill
  description saying "Triggers on" guides model selection; it is not a lifecycle hook.
  Skills load through `/name`, `skill_manager activate`, or matching frontmatter `paths`.
  See `agent_hooks_system.md` for the implemented hook events and execution modes.
- External `@path` imports from project files load only under the auto-approve tool
  policy; under the interactive policy they are skipped and logged (decision 5, partial).
- Tool-spawned subagents receive the parent's complete launch set, including enabled
  parent auto-memory, in their **system prompt**, unless `omitClaudeMd`; they do not
  do lazy loads. Agent-owned memory loads separately and currently does not check
  the auto-memory toggle.

## Validation

```bash
cd client/ygg-chat-r
npm run typecheck:server
npx vitest run --config vitest.headless.config.ts server/headlessServer/services/__tests__/contextLoading.test.ts
npx vitest run --config vitest.headless.config.ts server/headlessServer/services/__tests__/toolLoopService.hooks.test.ts
npx tsc -p tsconfig.app.json --noEmit
YGG_CONTEXT_DEBUG_LOGS=1 npm run dev:electron   # prints [ContextLoader] discovery lines
```

## Known gaps

- Conversation rule discovery always skips external project/nested symlink targets,
  even under auto-approve; approval is wired for instruction imports, not rules.
- `claudeMdExcludes` filters instructions and unconditional launch rules, but not
  lazy conditional/nested rules. Managed/user local and ancestor settings are not read.
- Compaction keeps cached unconditional rules and does not refresh startup indexes;
  successive skill re-attachment and agent-memory-toggle limitations are above.

- `/name` typed by the user is expanded server-side only; there is no renderer `/` menu
  for user-invocable skills yet.
- Visibility in chat is the `ContextInjectionCard` (`src/components/ChatMessage/ContextInjectionCard.tsx`):
  a theme-aware card per launch set, per tool result that triggered loads, and per user
  message that carried a `/skill` expansion or hook output. A message with such a card is
  never folded into "Agent Steps".
- `skillOverrides`, output styles, plugins, managed policy files are not implemented.
