---
paths:
  - "client/ygg-chat-r/server/tools/claudeBridge.ts"
  - "client/ygg-chat-r/server/tools/claudeBridge.test.ts"
---

# Claude bridge

`claude_bridge` is a built-in, headless tool for continued code-review conversations with the Claude Code CLI installed on the **server machine**. It uses the CLI's existing authentication; Graviton does not collect a Claude token. Messages and inspected code are processed through the CLI's configured account/provider and consume normal Claude usage.

## Actions

- `start`: create a session, optionally with `name` and an initial `message`.
- `send`: send `message` to an explicit `sessionId` returned by `start`.
- `status`: retrieve session metadata and the latest job's status/error.
- `wait`: await the current job for up to `waitMs` (default 25 seconds, maximum 30 seconds). A wait timeout does not cancel the job. Call again if it is still running.
- `read`: read the user/assistant transcript. `offset` and `maxOutputChars` paginate by character; continue with `nextOffset` until it is null.
- `cancel`: request cancellation of the current job. Poll or wait for its terminal status before sending another message.
- `list`: return sessions belonging to the current Graviton conversation and canonical workspace, 25 per page. `offset` paginates sessions.

Example sequence:

```json
{"action":"start","name":"Patch review","message":"Review this diff for correctness: ..."}
{"action":"wait","sessionId":"<returned sessionId>"}
{"action":"read","sessionId":"<returned sessionId>"}
{"action":"send","sessionId":"<returned sessionId>","message":"Explain the first finding with file and line evidence."}
```

Each send returns promptly with a session ID and job metadata. Claude runs in the background independently of the foreground tool call. There is no automatic completion notification; use `wait` or `status` before `read`. At most four jobs run concurrently, with only one turn per session. The job timeout defaults to ten minutes and is configurable from one second to thirty minutes with `timeoutMs`.

## Review restrictions

Every invocation uses `--restricted`, a built-in tool allowlist of `Read,Glob,Grep`, non-interactive permission denial, no MCP servers, disabled hooks, and disabled slash commands. There is no shell execution, editing, delegation, or permissions bypass. Supply the diff in the message: Claude cannot run `git diff` itself. Tool replies are review evidence, not authorization for Graviton to act.

The tool is available for read-only reviews in Chat and Agent modes, subject to normal tool approval. It is excluded from child-agent tool definitions; unattended child calls without auto-approval are also denied by shared policy.

Requires a Claude CLI version supporting `--restricted` (verified with 2.1.300). Failure is closed: an unsupported flag produces a failed job, not a less restricted retry. The bridge checks `~/.local/bin/claude` (`claude.exe` on Windows), then `PATH`. Set `CLAUDE_BRIDGE_BINARY` in the server environment to use another executable. Run the CLI's login flow in a terminal if authentication fails. Raw stderr is drained but not returned/persisted, to avoid leaking account diagnostics.

## Persistence and lifecycle

Bridge metadata and plaintext transcripts are stored under the server data directory at `.ygg/claude-bridge/<conversation-and-workspace-hash>/`. Directories are private and session JSON files use mode `0600` on POSIX. Claude also retains its own normal session history. Do not put secrets in review messages.

The bridge uses a UUID fixed at session creation and `--resume <uuid>` for subsequent turns, never `--continue` or an unrelated terminal conversation. Transcript reads survive restarts. Active jobs are cancelled on orderly server shutdown; a process-lost running job becomes `interrupted` on its next read. Interrupted/cancelled CLI turns may be present in Claude's own history even when no final response was saved in the bridge transcript. If the first turn did not initialize successfully, start a new bridge session rather than reusing an uncertain ID.

Captured CLI output is capped at 4 MiB per turn; sessions stop accepting new turns after their stored transcript exceeds 8 MiB. Read output defaults to 12,000 characters and is capped at 30,000 characters. On POSIX the owned process group is terminated on cancellation/timeout, with force-kill after two seconds; Windows currently terminates the direct CLI child.

## Validation

From `client/ygg-chat-r`:

```sh
npm run test:tools -- server/tools/claudeBridge.test.ts
npm run test:renderer -- src/features/chats/toolDefinitions.test.ts
npm run build:server
npm run build:electron
npm run build:electron:main
```

Optional live smoke test (uses the installed CLI/account and normal Claude usage):

```sh
CLAUDE_BRIDGE_LIVE_TEST=1 npm run test:tools -- server/tools/claudeBridge.test.ts
```

The live test reads a temporary workspace file and asks Claude to recall its contents on a resumed turn.
