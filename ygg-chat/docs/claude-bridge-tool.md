---
paths:
  - "client/ygg-chat-r/server/tools/claudeBridge.ts"
  - "client/ygg-chat-r/server/tools/claudeBridge.test.ts"
  - "client/ygg-chat-r/server/tools/claudeSessionStore.ts"
  - "client/ygg-chat-r/server/tools/claudeSessionStore.test.ts"
  - "client/ygg-chat-r/server/headlessServer/services/watchService.ts"
  - "client/ygg-chat-r/server/headlessServer/index.ts"
---

# Claude bridge

`claude_bridge` is a built-in, headless tool for continued code-review conversations with the Claude Code CLI installed on the **server machine**. It uses the CLI's existing authentication; Graviton does not collect a Claude token. Messages and inspected code are processed through the CLI's configured account/provider and consume normal Claude usage.

## Find a conversation by its human name

You do not need to know a UUID or remember which project directory the conversation used:

```json
{"action":"list","query":"authentication"}
{"action":"lookup","name":"Authentication review"}
{"action":"resume","name":"Authentication review","message":"Continue reviewing the fix."}
```

`list` defaults to **all local Claude project directories** plus bridge sessions attached to this Graviton conversation/workspace. Results contain names, IDs, directories, timestamps, source and active status—not transcript excerpts, first prompts, thinking, or tool results. Names themselves are visible metadata. `source:"bridge"` restores the old bridge-only list; `source:"claude"` reads the CLI catalog. Filter with `query` (substring search) or `directory`. Pages default to 25 entries (`limit` 1–100); continue with `nextOffset`.

`lookup`, `resume`, and `fork` accept **either `name` or `sessionId`**. Name comparison is exact after Unicode normalization, whitespace folding and case folding. Duplicate names return `AMBIGUOUS_SESSION` and candidate directories/IDs so the agent can ask which one you mean. Missing exact names return `SESSION_NOT_FOUND` with partial-name suggestions. Suggestions are never automatically resumed. `directory` disambiguates duplicate names; it does not override the verified original cwd.

## Resume or fork

- `resume` attaches an existing session ID and continues its original CLI history in its original canonical directory. It never substitutes a new empty conversation for a missing ID.
- `fork` prepares an independent conversation from the selected history. Its first message runs `--resume <source> --fork-session --session-id <new UUID>`. Optional `newName` sets the new display name. Further sends resume the new ID, not the source.
- Both accept an optional `message` to start a background turn immediately. With no message, resume attaches without inference, and fork creates a pending bridge session materialized on its first send. Its imported history boundary is refreshed at that first send to include source turns added while it was pending; a concurrently changing external source still makes the exact CLI fork point best-effort.
- `start` creates an empty conversation with optional `name`, `directory`, and initial `message`. Names are passed to Claude with `--name`, not just stored in Graviton.

```json
{"action":"resume","sessionId":"<existing Claude UUID>"}
{"action":"fork","name":"Authentication review","newName":"Authentication second opinion","message":"Check the earlier conclusions independently."}
```

The original cwd is verified from local metadata and selected automatically. Discovery is global, but **content reads and launches outside the current workspace require trusted Full access for the run, or switching to that workspace**. The bridge rechecks on every read/send; a tool argument cannot grant Full access. Full access does not grant shell/edit capabilities to Claude. Normal tool approvals still apply.

A live CLI registry entry with an existing process blocks direct resume (idle terminal sessions count as active too). Close that terminal session or fork it. The registry is best-effort race prevention, not an atomic lock shared with arbitrary external CLI processes. Graviton's own concurrent turns are serialized by session ID across conversations; cancellation only controls jobs owned by the calling conversation.

## Choose or switch models

```json
{"action":"models"}
{"action":"start","name":"Patch review","model":"haiku","message":"Review this diff."}
{"action":"send","name":"Patch review","model":"sonnet","message":"Check the concurrency risks more deeply."}
{"action":"fork","name":"Patch review","newName":"Independent review","model":"opus","message":"Recheck the conclusions."}
```

`model` accepts a CLI alias or a full provider model ID on `start`, `send`, `resume`, and `fork`. The selection persists in bridge metadata and survives restarts. A later `send` can switch models **between turns**, retaining the same session ID and history. Running jobs cannot be switched. `resume` without a message can set the next-turn choice without inference. A fork inherits an attached source's bridge override unless explicitly overridden; external sessions without a bridge choice use the CLI's normal restored/default model behavior.

Omitting `model` retains the bridge choice; if none exists, no `--model` flag is passed. Explicit `model:"default"` uses Claude's runtime default rather than the prior override, and persists that choice for later launches. This does not change the user's global Claude settings.

`models` returns a **documented catalog**, not verified account entitlements; it does not run inference or install an SDK. Verified against [official model configuration](https://code.claude.com/docs/en/model-config) on 2026-10-16: `sonnet`, `opus`, `haiku`, `fable`, `best`, `default`, extended-context aliases, and `opusplan`. Current direct Anthropic IDs include `claude-sonnet-5-5`, `claude-opus-5-5`, `claude-haiku-5-5`, and `claude-fable-5-1`. Aliases can resolve differently with provider, CLI version and settings. Haiku, Sonnet and Opus were live-tested on CLI 2.1.301, including a Haiku-to-Sonnet switch preserving history and an Opus fork. Other catalog entries are documented, not individually live-tested. The public CLI help has no model-list command; the Agent SDK has model discovery, but this direct-process bridge does not depend on that SDK or its control protocol.

**Fable and `best` can bill additional usage credits without a consent prompt in non-interactive mode.** Organization policy, account access and provider availability still apply. `opusplan` refers to Claude's permission mode, not Graviton's Chat/Agent mode; this bridge always uses `dontAsk`.

Session summaries expose `model` (null means no bridge override). Jobs expose `requestedModel` and, after a successful result, `modelsUsed` from CLI `modelUsage` keys when available. Those are reported usage models, potentially more than one, not a promise that an alias resolved to a particular version. Failed selections remain visible and never trigger a bridge fallback/retry. Claude's own configured/provider fallback behavior is outside that guarantee.

## Attached-session actions

`send`, `read`, `status`, `wait`, and `cancel` accept an attached `sessionId` or an exact attached-session `name`; they never implicitly attach global history.

- `send`: send a follow-up `message`.
- `status`: retrieve metadata and the latest bridge job's status/error.
- `wait`: in main chat, register automatic job-completion delivery and return immediately with a watcher handle and `autoResume`. Do not poll or keep calling wait. The exact job reply (up to 12,000 characters) is queued into the originating branch at its next safe boundary; a completed branch can start a same-lineage successor. A visible **Claude review ready/failed** notification uses the watcher transport. Repeated waits deduplicate by job/lineage. Already-finished jobs register too. `watcher status/cancel` accepts the returned handle; cancelling the watch does not kill the CLI job. CLI cancellation and server shutdown suppress delivery. With resumable runs disabled, delivery is visible-only (`autoResume:false`); inspect `read` manually. Legacy non-chat callers without branch continuation keep the bounded `waitMs` behavior (default 25 seconds, maximum 30).
- `read`: read imported user/assistant text plus subsequent bridge turns. `offset` and `maxOutputChars` paginate by character; continue with `nextOffset` until null. Tool payloads, thinking and child-agent turns are excluded from imported history.
- `cancel`: request cancellation of the owned current job. Wait for terminal status before sending again.

Example sequence:

```json
{"action":"start","name":"Patch review","message":"Review this diff for correctness: ..."}
{"action":"wait","sessionId":"<returned sessionId>"}
{"action":"read","sessionId":"<returned sessionId>"}
{"action":"send","sessionId":"<returned sessionId>","message":"Explain the first finding with file and line evidence."}
```

Each send returns promptly with a session ID and job metadata. Claude runs in the background independently of the foreground tool call. Call `wait` once to register automatic completion delivery, then do other work or end the assistant turn. No model-driven polling is necessary. Completion is a labelled automated external-review message, not user authorization. New jobs retain a trusted `job.source` with the launch action, tool-call ID and available assistant-message/stream IDs. Completion text names that original launch call, not the later `wait` call. Queued-row metadata preserves `source` and the separate `registrationToolCallId`; old jobs without provenance are explicitly labelled unavailable rather than guessed. Main-chat `waitMs` is ignored and there is no completion-watch deadline; `timeoutMs` remains the independent CLI job runtime safeguard. It reuses the [watcher safe-boundary queue](watcher-tool.md), retained permissions/mode and same-lineage routing; stopped/deleted/failed branches report delivery failure rather than silently forking. Notifications contain routing metadata only, never reply text. Registered waits are memory-only and share watcher capacity/status-retention limits; up to 4096 per-job/branch deduplication tombstones are kept until shutdown, after which new registrations fail closed; transcripts remain persisted for manual recovery. At most four jobs run concurrently, with only one turn per session. The job timeout defaults to ten minutes and is configurable from one second to thirty minutes with `timeoutMs`.

## Review restrictions

Every invocation uses `--restricted`, a built-in tool allowlist of `Read,Glob,Grep`, non-interactive permission denial, no MCP servers, disabled hooks, and disabled slash commands. There is no shell execution, editing, delegation, or permissions bypass. Supply the diff in the message: Claude cannot run `git diff` itself. Tool replies are review evidence, not authorization for Graviton to act.

The tool is available for read-only reviews in Chat and Agent modes, subject to normal tool approval. It is excluded from child-agent tool definitions; unattended child calls without auto-approval are also denied by shared policy.

Requires a Claude CLI version supporting `--restricted` (verified with 2.1.300 and 2.1.301; named discovery, external resume and fork live-tested on 2.1.301). Failure is closed: an unsupported flag produces a failed job, not a less restricted retry. The bridge checks `~/.local/bin/claude` (`claude.exe` on Windows), then `PATH`. Set `CLAUDE_BRIDGE_BINARY` in the server environment to use another executable. Run the CLI's login flow in a terminal if authentication fails. Raw stderr is drained but not returned/persisted, to avoid leaking account diagnostics.

## Persistence and lifecycle

Bridge metadata and plaintext transcripts are stored under the server data directory at `.ygg/claude-bridge/<conversation-and-workspace-hash>/`. Directories are private and session JSON files use mode `0600` on POSIX. Claude also retains its own normal session history. Do not put secrets in review messages.

The bridge uses explicit verified UUIDs and `--resume <uuid>`, never `--continue` or an interactive picker. Imported sessions record source history references and byte boundaries; `read` streams that bounded snapshot plus bridge turns rather than duplicating the complete history in bridge metadata. Transcript reads survive restarts. Active jobs are cancelled on orderly server shutdown; a process-lost running job becomes `interrupted` on its next read. Interrupted/cancelled CLI turns may be present in Claude's own history even when no final response was saved in the bridge transcript. If the first turn did not initialize successfully, start a new bridge session rather than reusing an uncertain ID.

Captured CLI output is capped at 4 MiB per turn; sessions stop accepting new turns after their stored transcript exceeds 8 MiB. Read output defaults to 12,000 characters and is capped at 30,000 characters. On POSIX the owned process group is terminated on cancellation/timeout, with force-kill after two seconds; Windows currently terminates the direct CLI child.

## Local discovery limits

The adapter reads `CLAUDE_CONFIG_DIR/projects` (default `~/.claude/projects`); no CLI inference is required for discovery. It reads the first/last 64 KiB of real top-level UUID JSONL files, with optional legacy `sessions-index.json` metadata and current `<UUID>/custom-title.json` sidecars. It never reconstructs a directory from a lossy encoded project-folder name, never trusts index `fullPath`, and ignores symlink storage entries. Discovery is capped at 10,000 files/projects, 64 MiB of sampled metadata and ten seconds. `incomplete`/`skippedFiles` disclose partial catalogs; incomplete name searches never auto-select a session.

Titles/summaries outside the sampled windows can be absent (`metadataSampled:true`). No first-prompt fallback is exposed. Missing history, missing cwd, deleted workspaces and malformed metadata fail safely. Imported textual history is limited to a 64 MiB source snapshot and a ten-second read. This is a local-storage adapter, not a stable public Claude API; upstream schema changes may require updates.

## Validation

From `client/ygg-chat-r`:

```sh
npm run test:tools -- server/tools/claudeBridge.test.ts server/tools/claudeSessionStore.test.ts
npm run test:renderer -- src/features/chats/toolDefinitions.test.ts
npm run build:server
npm run build:electron
npm run build:electron:main
```

Optional live smoke test (uses the installed CLI/account and normal Claude usage):

```sh
CLAUDE_BRIDGE_LIVE_TEST=1 npm run test:tools -- server/tools/claudeBridge.test.ts server/tools/claudeSessionStore.test.ts
```

The live test creates a named conversation, reads a temporary workspace file, continues it, discovers it by name from another Graviton conversation, imports its history, and forks it into an independently persisted CLI session. It starts on Haiku, switches the same history to Sonnet, and forks on Opus; CLI model-usage keys are checked. It only touches test-created conversations and uses normal Claude account usage.
