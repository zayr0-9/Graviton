---
paths:
  - "shared/claudeProvider.ts"
  - "client/ygg-chat-r/server/headlessServer/services/claude*.ts"
  - "client/ygg-chat-r/server/headlessServer/persistence/claudeSessionRepo.ts"
---

# Claude Code provider v1

Claude Code is a separate main-chat execution backend. The Agent SDK drives the installed host CLI; Claude owns model execution, tools, native transcript and compaction. Graviton stores a display projection in the existing message/lineage tree and serves its existing streaming/Heimdall interface. Other providers still use ToolLoopService. Graviton tools, hooks and context loader are not injected into Claude sessions.

## Start and continue

Install Claude Code on the host and complete its login in a terminal. Select **Claude Code**, select Haiku/Sonnet/Opus 5.5, and choose a workspace folder before the first send. An explicit `CLAUDE_BRIDGE_BINARY` can select the installed executable. No Graviton token collection or OAuth-token extraction is used. The CLI's authentication/provider environment determines billing; an inherited `ANTHROPIC_API_KEY` may select API billing. Account eligibility and third-party usage terms still apply.

After the first accepted user row, provider and model are fixed on that ancestry; forks inherit them. Model controls are disabled and server admission validates persisted ancestry. Existing other-provider history cannot be switched to Claude. A new independent conversation may choose another provider/model. Workspace is fixed per native branch.

SDK `forkSession(session, { upToMessageId })` creates an independent historical session. Shared ancestors remain shared Graviton nodes, with source session/message checkpoint mappings. Only successful completed-turn response checkpoints are resumable/forkable in v1. Root user edit/repeat starts a new native session with inherited identity. Arbitrary tool-block or partial-output cuts are refused instead of silently importing a different context. Native forks do not undo workspace side effects.

Session data is required for continuation; deleting it leaves the Graviton display copy readable but cannot silently start a replacement. Failed/interrupted native execution is marked uncertain; fork from a completed ancestor to recover. Startup-lost `running` state is also treated as uncertain. No external terminal sessions are attached automatically.

## Tools and permissions

Claude uses its native tools, not Graviton's tool registry or subagent engine. SDK permission requests are routed through DecisionBroker and the existing stream-specific approval UI. Claude permission mode is `plan` for Chat and `default` for Agent. Mode changes apply between turns only. There is no permission-bypass mode, no inherited host auto-approval, and Allow All is disabled/rejected for Claude. Tools Claude considers safe may execute without prompting; native permission prompts require explicit approval. AskUserQuestion/ExitPlanMode prompts are denied with instructions to ask in prose or switch modes in the UI.

Only explicit SDK settings are loaded (`settingSources: []`), MCP configuration is empty/strict, and user hooks are disabled. Admin-managed policy/hooks remain Claude-owned. Native tools get a filtered environment, not Graviton's unrelated app credentials. This is not OS sandbox isolation.

## Scope limits

- Text and selected-file context only; pasted image attachments are rejected.
- No queued user input or live mode changes during a turn.
- No Graviton manual compaction, custom tools, REPL, hooks or subagent controls.
- Native child details remain in Claude's own transcript; parent tool activity/results are projected.
- Direct content edits and individual message deletion are rejected; use an edit branch or delete the whole Graviton conversation. Notes remain editable. Deleting the Graviton conversation does not delete Claude's native session files.
- The displayed model list is a configured catalog, not verified account entitlement.
- Uses installed CLI plus version-pinned SDK `0.3.309`; no bundled CLI resolution relative to esbuild output.

## Persistence

Migration 12 adds `claude_branch_sessions` (lineage, locked model/workspace, native session/state) and `claude_message_checkpoints` (Graviton row to native UUID). `messages.meta` records Claude provenance and existing model selection. API response blocks sharing a native `message.id` aggregate into one Graviton row; native tool results enrich the matching tool-owner row without creating competing execution.

## Validation

Run the focused `claudeSessionService`, `claudeSessionRepo`, `decisionBroker`, and `chatOrchestrator.phase2` headless tests with the matching Electron SQLite ABI. Renderer branch selection/request/model-switch tests cover identity projection. Run native/browser renderer, Electron main and standalone server builds.

Opt-in live smoke (normal account usage, test-created temporary workspace/sessions only):

```sh
CLAUDE_PROVIDER_LIVE_TEST=1 node scripts/test-claude-session-live.mjs
```

It verifies real SDK response UUID retrieval, historical fork/remapping, context recall, source-session independence, native Read and a denied Write callback with no created file. This does not prove full packaged UI or every provider/account configuration.

## Observed implementation checks

On the implementation host (installed CLI 2.1.310 / SDK 0.3.309): live native SDK and actual service tests passed historical fork/recall, independent source transcript, native Read, broker-denied Write with no file created, and broker-approved Write creating the expected file only in the isolated test workspace. Full renderer: 1,202 passed; matching-Electron-ABI headless: 889 passed, one live-test skip, 24 todo; matching-ABI server: 265 passed, one skipped; tools: 494 passed, two skipped. Native/browser renderer, Electron main/mobile and standalone server builds passed. Existing production shared-browser fixture and ten native selection checks passed; these are regression fixtures, not a full Claude UI acceptance test. The default system Node cannot load the existing Electron SQLite binary; dependencies were not rebuilt.

Opus 5.5 reviewed the implementation iteratively and its final pass (`91078bd7-1a81-4926-9cf2-f0dd8cec6db6`, session `12171405-5e5a-467b-8db8-d15761d4b5ab`) reported no remaining blockers for the explicit v1 scope. Accepted issues in transcript guards, approval policy, per-token writes, response aggregation and stopped-run admission were fixed/tested. Rare SDK `supersedes` refusal-fallback display reconciliation, native child detail parity, packaged/Windows and full real-user UI acceptance remain follow-ups. No ZIP/release or push was performed for this feature.
