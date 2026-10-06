---
paths:
  - "client/ygg-chat-r/server/headlessServer/services/watchService.ts"
  - "client/ygg-chat-r/server/tools/orchestrator/ToolOrchestrator.ts"
  - "client/ygg-chat-r/src/services/ToolJobManager.ts"
  - "shared/watchEvents.ts"
---

# Asynchronous watcher tool

`watcher` is a built-in server-owned tool, not a custom plugin. The custom-tool
architecture was inspected first: plugins can run in a utility runtime and their
options do not carry the durable branch lineage. Like `subagent_manager`, this
manager intercepts the full server tool context before the leaf job registry.
Normal tool permission, hook and nested `multi_call` paths remain in force.
It does not consume an orchestrator worker slot for the watch lifetime.

## Schema

Canonical schema: `shared/builtinToolDefinitions.ts` (`watcher`).

| Field | Meaning |
| --- | --- |
| `action` | Required: `start`, `status`, `cancel`, `list` |
| `handle` | Required for status/cancel; opaque UUID returned by start |
| `kind` | Required for start: `process_exit`, `file_created`, `file_changed`, `log_match`, `http_status` |
| `pid` | Positive native host PID for process_exit |
| `path` | File path for file/log watches, resolved with existing workspace policy |
| `pattern` | Nonempty literal string or regex source for log_match; at most 2048 characters |
| `regex` | Default false; true selects regex matching |
| `url` | HTTP(S) URL for http_status; embedded username/password rejected |
| `expectedStatus` | HTTP status 100–599; default 200 |
| `timeoutMs` | 100–86400000 ms; default 300000 |
| `checkIntervalMs` | 100–60000 ms; default 1000; delay after a completed check |

`start` validates options synchronously, schedules its first check for the next
event-loop turn, and returns `{success, handle, state: "waiting", kind,
createdAt, notification: "queued_user_message", autoResume: true}` when the
resumable chat runtime is enabled. With resumable runs explicitly disabled it
returns `notification: "visible_only", autoResume: false` instead. It performs no
condition I/O before returning. `status` and `list` return immediately from memory.
States are `waiting`, `triggered`, `timed_out`, `cancelled`, `error`. Terminal views
include `completedAt`; errors contain only a fixed, condition-free explanation.
Cancellation is idempotent and does not kill the watched process.

## Benchmark example

Start the benchmark independently (for example in Graviton's terminal), capture
its native host PID, then call:

```json
{"action":"start","kind":"process_exit","pid":12345,"timeoutMs":3600000,"checkIntervalMs":1000}
```

The assistant can do other work or end its turn immediately. When the PID is no
longer present, a **Watch triggered** banner appears in the existing agents pill.
Completion automatically submits a real user message to the originating branch
and lets the assistant inspect benchmark results with normal tools. Click the
banner to view that work; clicking is not required to continue. Call `status` with
the returned handle to inspect watch state and delivery acceptance.

## Push delivery versus assistant resumption

Completion uses a narrowly typed `watch_completion` event over the existing
`subscribe_jobs` WebSocket transport. It is **push delivery**, not renderer status
polling. The renderer maps it to the existing navigable notification surface.
Notification IDs and server terminal transitions suppress duplicate events.
The transport retains the newest 256 completions in memory and replays them on
subscription/reconnect; the renderer deduplicates the newest 256 handles. A fresh
renderer session may show a retained completion again. Existing notification
presentation limits and auto-dismiss apply. This is not durable/exactly-once
messaging; events lost beyond retention cannot be recovered from the notification
channel. Branch status remains independently inspectable while retained.

## Automatic branch continuation

Triggered, timed-out and error completions submit a bounded, clearly labelled
**automated user message** via the existing safe-boundary input queue. Cancel and
shutdown do not submit messages. `requestId = watcher:<handle>` deduplicates intake;
user rows have `meta.kind = watcher_completion`, handle and origin-message ID.

- A live main-chat run receives the message after its current provider/tool batch
  and compaction finish. Existing hooks, mode ordering, persistence, lineage
  bookkeeping and inference continuation apply without a second loop.
- If the branch has advanced through another normal send, completion routes to
  the latest resolved run on the **same lineage**, not the originating tool-call
  message or the user's currently selected UI branch.
- A normally completed branch starts a server-owned successor from its current
  tail, reusing the existing queued-send launch path and retained run settings.
  The completion push carries stream identity; the renderer adopts/reattaches
  in the background without changing selected path or consuming image drafts.
- Active watches pin the originating and latest same-lineage continuation
  mailboxes so normal terminal-cache eviction does not lose run configuration.
  Pins release on completion/cancel/shutdown. Pin retention is bounded by watch
  limits in addition to the usual 64 retained unpinned mailboxes.
- Failed/stopped, archived/deleted, unresolved-initializing, externally advanced
  (without a matching retained run), or turn-limit/closed-intake races can reject
  delivery. The banner reports **could not deliver**, and status reports
  `delivery: failed`; the watch outcome remains triggered/timed_out/error.
  These cases require manual continuation. No silent fork or permission upgrade.
- `delivery: queued` means accepted, not yet persisted: UserPromptSubmit may block
  it, Stop may interrupt before the next boundary, or turn limits may be reached.
  The normal queue UI exposes failed entries. `delivery: restarted` means a
  successor was launched, not that its inference succeeded.
- Main-chat continuation requires server resumable runs (default on). When that
  flag is off watches remain visible-only. Watches invoked from subagent
  transcript contexts are rejected when automatic delivery is enabled: those
  transcripts do not have the main-chat queue and cannot be treated as its branch.

`/api/resume` remains decision-only. Automatic continuation uses queued input,
not a new wake-up protocol, arbitrary renderer-selected provider configuration,
or a direct SQLite insert into an in-progress tool batch.

Events include only handle, fixed kind/state/delivery, routing IDs (including
continuation stream/tail IDs) and completion time.
No paths, URLs, regexes, log matches, response bodies or raw errors enter notices.
Tool invocation arguments remain subject to the harness's usual logging rules:
do not put credentials in URLs, patterns or paths.

## Condition semantics and limitations

- Polling conditions run asynchronously in the server, never through arbitrary
  shell commands. Watches survive chat completion/navigation, but not app restart.
- Ownership uses `(conversationId, lineageId)`, never caller-supplied branch IDs.
  Missing lineage is rejected. Other branches cannot list/status/cancel a handle.
  All local desktop job-channel subscribers may receive the secret-free routing
  event, just like existing global job notifications; this is not a multi-tenant
  remote authorization boundary.
- Limits: 16 active watches per branch, 32 retained per branch, 256 total.
  Old terminal watches are evicted when needed; a discarded handle is not found.
- Native process existence uses `process.kill(pid, 0)`. An already absent PID
  triggers; permission-denied means still present. No exit code, PID-reuse
  protection, zombie detection, descendant tracking or WSL PID translation.
- `file_created` means a regular file currently exists (already present triggers).
  Missing files wait. `file_changed` establishes a baseline on its first successful
  check, then compares device/inode/size/mtime/ctime. A missing initial file waits
  for a baseline; creation alone does not trigger change. Temporary absence waits.
  Use file_created for creation. Short-lived files or changes between checks may
  be missed. Paths follow the existing workspace policy and filesystem symlinks.
- Logs are read from the beginning in 64 KiB chunks per check with a 4096-character
  overlap for boundary matches. Truncation/inode replacement restarts reading.
  No log text is returned. Patterns requiring larger cross-chunk spans and split
  multibyte UTF-8 sequences are not guaranteed. Only regular files are accepted.
- Regex evaluation runs in a disposable worker with a 500 ms budget so a
  pathological expression cannot stall the conversation. Budget exhaustion is
  `error`, not a non-match. Workers are terminated on timeout/cancel/shutdown.
- HTTP uses credential-free GET, no custom headers, cookies, request body or
  redirects; each request has a 5 s abort budget. Unreachable endpoints, request
  timeouts and wrong statuses wait until the watch deadline. URLs use the local
  tool permission trust boundary, not a new remote-network allowlist. Avoid
  endpoints where GET has side effects.
- Cancellation/timeout aborts HTTP and regex work and clears timers. Pending file
  operations finish asynchronously and close their handles; late results cannot
  override a terminal state or send a second event. Shutdown cancels all watches
  before the job transport shuts down, without completion notices.
- Timer deadlines require a responsive server event loop. Conditions are sampled,
  not guaranteed to record every underlying OS event.

## Validation

From `client/ygg-chat-r`:

```sh
npm run test:headless -- server/headlessServer/services/__tests__/watchService.test.ts server/headlessServer/services/__tests__/watchContinuation.test.ts server/headlessServer/services/__tests__/messageInputQueue.test.ts server/headlessServer/routes/__tests__/messageQueueRoutes.test.ts
npm run test:renderer -- src/features/chats/watchContinuation.test.ts src/services/ToolJobManager.test.ts
npm run typecheck:server
npx tsc -p tsconfig.app.json --noEmit
```

Manual Electron check: register a watch from a chat, end the turn, navigate to
another conversation, trigger the condition, then verify the banner opens the
original branch. Also disconnect/reconnect the job channel, cancel before a
trigger, and quit with a pending HTTP/log watch. The assistant should continue automatically on accepted completion, and no user
message or inference should be generated for cancellation/shutdown.
