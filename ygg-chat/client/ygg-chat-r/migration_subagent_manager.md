# Subagent Manager — Implementation Progress Log

Tracks the build of a **global `subagent_manager` tool**: async (fire-and-forget)
subagents keyed to the spawning branch, a transcript viewer in the renderer, and
run-level **resume** + in-loop **retry**. This log is self-contained so it survives
context compaction — a fresh session should be able to resume from it alone.

- **Branch:** `feat/headless-agent-loop` (local, not pushed).
- **Commit identity:** ALWAYS `Karan Singh <z3yr0.0.9@gmail.com>` (personal `zayr0-9`
  account), never the vega work account. Commit only when asked.
- **Checkpoint commit:** `8241cd7` — bundles Phase 0 **plus** the pre-existing
  in-progress content-lineage/fork + tool_invocations feature (user chose "commit
  everything" for that checkpoint).
- **Full design discussion + consolidated plan:** in the originating chat session
  (the key decisions + per-phase specifics are reproduced below so they persist).

## Phase status

| Phase | Goal | Status | Notes |
|---|---|---|---|
| 0 | Persistence & schema foundations | ✅ done | in checkpoint `8241cd7` |
| 1 | Spawn engine (blocking + async) | ✅ done | committed `d88404a` (service + its test + this log) |
| 2 | `subagent_manager` tool (executor-layer interceptor) | ✅ done | committed (see Phase 2 section) |
| 3 | In-loop provider-error retry | ✅ done | committed (see Phase 3 section) |
| 4 | Resume (`subagent_manager.resume`) | ✅ done | committed (see Phase 4 section) |
| 5 | UI: persisted transcript viewer | ✅ done | committed (see Phase 5 section) |
| 6 | UI: live streaming | ✅ done | committed (see Phase 6 section) |

**All phases landed.** Spawn (blocking + async), the branch-scoped `subagent_manager`
tool (spawn/list/status/cancel/resume), in-loop provider retry, resume + startup
reconciler, the persisted transcript viewer, and live streaming are all in.

---

## Locked design decisions

- **Ownership anchor = `lineage_id`** (defensively scoped by `conversation_id`).
  It is the only anchor that is BOTH distinct-per-parallel-branch (forks always mint
  a fresh uuid, so branch-A/branch-B in one conversation never collide) AND stable
  across turns/sends/detach-reattach/resume (so a later poll still resolves the same
  owner set). `conversation_id` alone contaminates (many lineages per conversation);
  `stream_id`/`message_id` fragment (change per run/turn); `tool_call_id` is per-call.
- **Executor-layer interceptor, NOT an orchestrator-registered handler.** A plain
  global handler has `lineageId` DROPPED by `executeToolViaOrchestrator`
  (`index.ts` `submit()` forwards only `{rootPath, operationMode, conversationId,
  messageId, streamId}`). The interceptor (like `createSubagentDispatchExecutor`)
  sees the full `ToolExecutionContext` incl. `lineageId`.
- **No nested subagents** — `subagent_manager` is excluded from the child tool set.
- **One tool call → one run** (`subagent_runs.tool_call_id` ↔ the provider tool_use id),
  so UI/resume correlation is exact.
- **6-digit handle** returned by async spawn; ownership enforced by the `lineage_id`
  check on read, NEVER by handle possession (handles are labels, not capabilities).
- **Blocking is a param on one spawn path** (`blocking: true` = await + return text;
  `false` = return handle immediately, run outlives the tool call).
- **Resume:** reopen the SAME runId (compare-and-set); orphaned tool_use →
  synthesize `is_error` result, never re-execute; **persistence-backed** (handle on
  row + startup reconciler) so crash victims are resumable.
- **Retry:** subagent-only first; automatic/internal (NOT a manager action).
- Per-turn provider timeout should be classified resumable-transient (today folded
  into `error`).

---

## Phase 0 — Persistence & schema foundations ✅ (in `8241cd7`)

**`electron/localServer.ts`**
- `subagent_runs` DDL (~line 1404): added `handle TEXT`, `attempt INTEGER NOT NULL
  DEFAULT 0`, `last_turn_at DATETIME`.
- Indexes: partial `UNIQUE(handle) WHERE handle IS NOT NULL` (many NULLs allowed,
  uniqueness on real handles) + `idx_subagent_runs_tool_call`.
- Idempotent migration block (~1445+) for existing DBs: PRAGMA-guarded `ALTER`s +
  `CREATE ... IF NOT EXISTS`. Verified idempotent across re-runs.
- 6 new prepared statements (~2232+): `getSubagentRunByHandle`,
  `getSubagentRunsByToolCallId`, `getSubagentRunsByLineageId`,
  `getSubagentRunsByLineageAndStatus`, `attachSubagentRunHandle`,
  `reopenSubagentRun` (compare-and-set `WHERE id=? AND status IN ('error','aborted')`).

**`electron/headlessServer/persistence/subagentRunRepo.ts`**
- `SubagentRunRow` + `normalizeSubagentRunRow` + `CreateSubagentRunInput` extended for
  `handle`/`attempt`/`last_turn_at`.
- `createRun` mints a unique 6-digit handle (collision retry; explicit override via
  `input.handle`); `assignHandle` no-ops if the statement is absent (minimal harnesses).
- New methods: `getRunByHandle`, `listByToolCall` (with transcript),
  `listByLineage(lineageId, status?)` (lightweight, no transcript — the isolation
  query; lights up the dormant `idx_subagent_runs_lineage_status`), `reopenRun`
  (atomic error|aborted→running, bumps `attempt`, guards completed/running).

**Tests:** `subagentRunRepo.test.ts` schema+statements mirror updated + cases for
handle uniqueness, by-tool-call, by-lineage(+status) with branch isolation, reopen CAS.

## Phase 1 — Spawn engine ✅ (uncommitted)

**`electron/headlessServer/services/subagentRunService.ts`**
- Split `run()` into `prepareRun()` (token refresh + resolve tools + `createRun` +
  `streaming_runs` upsert + `started` emit + user-prompt persist → returns
  `PreparedSubagentRun` incl. `handle`) and `driveRun()` (the loop + terminal
  handling). `run()`/`runForTool()` (blocking) behavior preserved.
- `spawnDetached(request)`: `prepareRun` then `driveRun` fired **un-awaited** under an
  **owned `AbortController`**, registered in an in-process `activeRuns: Map<handle,
  {runId, controller}>`; returns `{handle, runId, streamId}` immediately. `.catch` →
  `persistUnexpectedFailure` backstop; `.finally` deregisters.
- `cancel(handle)` aborts a live detached run (→ `aborted`); `isActive(handle)`.

**Tests:** `subagentRunService.test.ts` — fake repo now mints a handle; added
`waitFor`; new cases: spawnDetached returns handle + completes in background;
`cancel(handle)` aborts in-flight run. **Result: 10 pass / 1 pre-existing fail.**

## Phase 2 — `subagent_manager` tool ✅

**`shared/builtinToolDefinitions.ts`** — new `subagent_manager` model-visible tool
(after `subagent`): `action` enum `spawn|list|status|cancel|resume` + spawn args
(`prompt`, `blocking`, `systemPrompt`, `orchestratorMode`, `tools`,
`inheritAutoApprove`, `temperature`), `status` (list filter), `handle`.

**`electron/headlessServer/services/subagentToolExecutor.ts`**
- New `SubagentManagerRunner` interface (spawnDetached / spawnBlocking / cancel /
  isActive / getRunByHandle / listByLineage) — implemented by `SubagentRunService`.
- New `createSubagentManagerExecutor({leafExecutor, runner})`: intercepts
  `subagent_manager`, routes actions, everything else → leaf. Reads the full
  `ToolExecutionContext` (esp. `lineageId`), which a registry handler would drop.
- **Ownership** (`ownsRun`): `!!ctx.lineageId && run.lineage_id===ctx.lineageId &&
  run.conversation_id===ctx.conversationId`. A null owner-lineage owns nothing
  (no null==null match). `notOwnedResult` is identical for unknown vs other-branch
  handles (can't probe another branch's handles). Returns concise transcript-free
  `toRunView` (+ `resumable`/`live` flags). `resume` is a stable "not available
  yet" stub until Phase 4. `buildSubagentRequest` tool filter now also drops
  `subagent_manager` (no nesting).

**`electron/headlessServer/services/subagentRunService.ts`** — added
`spawnBlocking(request, signal)` (same prepareRun/driveRun engine as detached, just
awaited; returns `{handle,runId,streamId,status,result,error}`; never throws on a
subagent error), plus `getRunByHandle` / `listByLineage` pass-throughs.

**`electron/headlessServer/index.ts`** — `subagent_manager` added to
`HEADLESS_RUNTIME_BUILTIN_TOOL_NAMES` (advertised) and `SUBAGENT_EXCLUDED_TOOL_NAMES`
(no nesting). `chatToolExecutor` now = manager interceptor → dispatch (`subagent`)
→ multiCall/leaf. **`src/features/chats/toolDefinitions.ts`** — added to
`OPENAI_LOCALLY_SUPPORTED_BUILTIN_TOOL_NAMES` (mirrors `subagent`).

**Verified:** flow trace confirmed `lineageId`/`conversationId`/`signal` survive the
`createChatPausingExecutor` (spreads `{...context}`) → interceptor; chatOrchestrator
always resolves a non-null `lineageId`. `tsc -b` (src+shared) clean; 0 tsc errors in
the 3 touched source files. **Tests:** `subagentToolExecutor.test.ts` 16 pass (5
dispatch + 11 new manager incl. the branch-A-vs-B isolation must-have). Full headless
suite: 291 pass / 2 pre-existing fail / 58 skip.

## Phase 3 — In-loop provider-error retry ✅

Retries a TRANSIENT provider failure inside a single turn instead of failing the run.
Opt-in via robustness; subagents opt in, main chat stays off.

**`providers/providerErrorFormatter.ts`** — extracted the transient status/keyword
set into `matchesTransientPattern(status, lower)` and exposed
`isTransientProviderError(error)` (provider-agnostic — no OpenAI gate; subagents run
on zai/bedrock/openrouter). `formatProviderErrorForAssistant` now reuses the same
predicate for `retryExhausted` (behavior unchanged).

**`services/toolLoopService.ts`** — `generateProviderTurn` now wraps
`providerRouter.generate` in a `for(;;)` attempt loop. On a transient error with
retries left: emit `tool_loop {status:'provider_retry', turn, attempt, maxAttempts}`,
`abortAwareSleep(base*attempt + jitter)` (rejects → propagates on cancel), then retry
the SAME turn — **no error row persisted, turn counter NOT advanced**. Only once
retries are exhausted (or disabled / non-transient) does it fall through to the
existing persist-and-throw path. New `ToolLoopRobustnessOptions`:
`retryProviderError?` / `maxProviderRetries?` (default 2) / `providerRetryBackoffMs?`
(default 750). Constants: `DEFAULT_MAX_PROVIDER_RETRIES=2`,
`DEFAULT_PROVIDER_RETRY_BACKOFF_MS=750`, `PROVIDER_RETRY_JITTER_MS=400`.

**`contracts/headlessApi.ts`** — `tool_loop` status union gains `'provider_retry'`
plus optional `attempt?` / `maxAttempts?`.

**`services/subagentRunService.ts`** — subagent robustness now includes
`retryProviderError: true`.

**Verified:** 0 new tsc errors in the 4 touched source files. `subagentRunService.test.ts`
(runs locally): recovers-after-429, exhausts-after-initial+2, non-transient-400-no-retry
all pass. `toolLoopService.test.ts` (self-skips locally, runs in CI) adds precise
`providerRetryBackoffMs:1` cases: recovers (asserts turnsUsed unchanged), exhausts (3
calls), non-transient (1 call), disabled/no-robustness (1 call).

## Phase 4 — Resume (`subagent_manager.resume`) ✅

Turns the Phase 2 `resume` stub into a real background resume of a terminated
(error|aborted) run, reusing the SAME runId + handle but a NEW streamId.

**Status gate = the atomic `reopenRun` CAS** (error|aborted → running, bumps
`attempt`). If it does not transition (run already running/completed), resume
drives nothing and reports "not resumable" — this is the double-run guard.

**History rebuild.** Instead of the synthetic `[{role:'user', prompt}]`, the loop
replays the persisted transcript (`getMessages(runId)`). The persisted row shape
already carries `role`/`content`/`content_blocks`/`tool_calls`, and the codex
(OpenAI) request builder derives `function_call_output` items from the assistant's
`tool_result` content-blocks (not from separate `role:'tool'` rows, which the sink
never persists), so an assistant-only rebuild pairs correctly. Compaction trim is
free: `generateCompactionSummary` stores summaries with the resume-line prefix, so
the loop's own `trimHistoryToLatestCompaction` recognizes them on rebuild without
the (unpersisted) `__auto_compaction_summary__` note.

**Dangling tool_use repair** (`repairDanglingToolUse`). A crash can persist an
assistant with `tool_calls` whose results were never merged. OpenAI Responses
rejects a `function_call` with no matching `function_call_output`, so for each
`tool_calls[].id` lacking a `tool_result` block we synthesize
`{type:'tool_result', tool_use_id, content:'[interrupted…]', is_error:true}` and
mark the call errored — via `updateMessageToolState`, **never re-executing** the
tool. (Results merge atomically per turn, so only the tail assistant is ever
dangling, but the sweep covers every assistant defensively.)

**Budget recount.** `turns_used` is stale (often 0) after a crash, so `priorTurns`
= count of persisted assistant rows; the resumed loop runs with `maxTurns -
priorTurns` and persists `priorTurns + result.turnsUsed`. `turnsUsed` is seeded to
`priorTurns` so an interrupted resume still records the prior work.

**Startup reconciler** (`reconcileOrphanedRuns`, called once in `index.ts` after
the service is built). Any run still `running` at process start is a crash orphan
(a fresh process owns no live loop) → flipped to a resumable `error`
(`ORPHANED_RUN_ERROR`). Idempotent. Backed by a new `getRunningSubagentRuns`
statement (`localServer.ts`) + `SubagentRunRepo.listRunning()`.

**Wiring.** `SubagentRunService.resumeDetached(runId, request)` (owned
AbortController, registered in `activeRuns` by handle so `cancel` works, drives in
background, `.catch`→`persistUnexpectedFailure`, `.finally`→deregister); `driveRun`
gained an optional `ResumeState` (history / userContent='' / assistantParentId=tail
/ priorTurns). `SubagentManagerRunner` gains `resumeDetached`; `managerResume` is
now async — ownership check → resumable gate (honest messages for
running/completed) → `buildResumeRequest(run, ctx)` (identity from the run row,
auth/rootPath/autoApprove from the live context, default tool set) → resumeDetached
→ null means the CAS was lost to a race.

**Verified:** `tsc -b` clean; 0 new electron tsc errors in the touched source
files. `subagentToolExecutor.test.ts` 19 pass (+4 resume: resumes-terminated /
not-completed / not-running / not-another-branch). `subagentRunService.test.ts`
(runs locally) +4: resumes-from-rebuilt-transcript (asserts the prior assistant is
replayed + budget carried + `attempt` bumped + resumed streaming row), dangling
repair (synthetic is_error result, tool NOT re-executed), reopen-CAS-fails-when-not-
resumable, and reconciler (2 orphans → error, completed untouched, idempotent).
Full headless suite: 303 pass / 2 pre-existing fail / 62 skip.

## Phase 5 — UI: persisted transcript viewer ✅

Adds a "View transcript" button to `subagent`/`subagent_manager` tool cards that
opens the persisted subagent conversation in a modal. Pure wire-up on top of the
Phase 0 repo; no new engine work.

**Server.** `services/subagentRunService.ts` — new `listByToolCall(toolCallId)`
pass-through (returns runs WITH transcripts). `routes/subagentRoutes.ts` — new
`GET /api/subagents/by-tool-call/:toolCallId` → `{ runs }`. Auto-wired: the route
is registered inside the already-mounted `registerSubagentRoutes`, which now sees
the new service method (no `index.ts` change). Route test +2 cases (returns runs
with transcript; empty array when none match) → 9/9 pass.

**Shared type.** `shared/types.ts` now owns the canonical `SubagentRunRow` /
`SubagentMessageRow` / `SubagentRunStatus` / `SubagentMessageRole`;
`persistence/subagentRunRepo.ts` imports + re-exports them (all existing server
importers keep importing from the repo module — zero call-site churn) so server
and renderer share ONE definition and can't drift.

**Renderer.**
- `hooks/useQueries.ts` — `useSubagentByToolCall(toolCallId)` (electron-only,
  `staleTime 30s`), key `['subagents','by-tool-call',toolCallId]`.
- NEW `components/SubagentTranscript/SubagentTranscript.tsx` — extracted the
  Heimdall block renderer (text / tool_use / tool_result / thinking) + the
  per-run flatten (`buildDedicatedSubagentMap` logic) into a standalone
  `SubagentRunView` / `SubagentTranscript` / `SubagentTranscriptModal` (portals to
  `<body>` like `ImageModal`). Also exports `SubagentToolName` (a tiny component
  that fetches the run and returns the tool-name `<span>` with a status-derived
  class) + `subagentStatusToolNameClass`.
- `components/ChatMessage/ChatMessage.tsx` — new `onOpenSubagentTranscript?` prop;
  `isSubagent` flag (matches `subagent`/`subagent_manager`); a
  `renderSubagentTranscriptButton(group.id)` mirroring `renderHtmlViewerButton`
  slotted into the tool header row. **`group.id` IS the provider tool_call id**,
  which the by-tool-call read resolves directly. **Status chip fix:** for subagent
  cards the tool-name uses `<SubagentToolName>` (status from `run.status`) instead
  of the result-derived class — an async spawn's result is only a handle, so the
  generic card would otherwise show "success" while the run is still running.
  (`SubagentToolName` is a component, not an inline call, because
  `renderToolCallGroupCard` runs inside a `.map` and must not call a hook.)
- `containers/Chat.tsx` — `subagentTranscriptToolCallId` state +
  `openSubagentTranscript` handler, passed to all 7 `<ChatMessage>` sites, and one
  `<SubagentTranscriptModal>` mounted beside the other Chat modals (Chat-scoped,
  no App-level context needed).

**Verified:** `tsc -b` (src+shared) clean (exit 0); 0 new errors in the touched
electron files. Headless suite: my 2 route tests pass; the only failure is the
pre-existing plan-mode mcp-filter test (confirmed unchanged with my service edit
stashed). No circular imports (ChatMessage → SubagentTranscript → chatMessageShared,
a leaf util). Feature is electron-only (the hook is gated on `environment`).

## Phase 6 — UI: live streaming ✅

Makes a running (or resumed) subagent stream its progress into the transcript
viewer live, then fold into the persisted transcript on completion.

**The blocker it solves.** Manager-spawned runs drive in the BACKGROUND with a
NOOP emit and never registered with `RunSessionRegistry`, so there was no live
stream and `GET /api/streams/:childStreamId` 410'd. Fix: the service now publishes
every run's events into a RunSession keyed by its child streamId, so the EXISTING
shared `GET /api/streams/:streamId` route (chatRoutes) replays it — no new stream
route, no change to the subagent SSE/POST route.

**Server.**
- `SubagentRunService` takes an optional `runSessions: RunSessionRegistry`.
  `prepareRun`/`prepareResume` `create()` a session for the child streamId and
  publish `started`; `driveRun` wraps its emit in `publishAndEmit` so every loop
  event + the terminal complete/error is published (which marks the session
  terminal). `index.ts` passes the SHARED chat registry, gated on `resumableRuns`
  (same gate as the streams route; off => no live stream, persisted still works).
  Verified the reaper is safe: a never-attached running session has
  `detachedAt === null`, so it is only reaped 60s AFTER terminal — exactly the
  flip-to-persisted window; a viewer disconnect `detach()`es without aborting the
  background run.
- `GET /api/subagents/by-tool-call/:toolCallId` now also returns the current child
  `streamId` (new `getLatestSubagentStreamIdByToolCall` stmt +
  `StreamingRunRepo.latestSubagentStreamIdByToolCall` +
  `SubagentRunService.latestStreamIdForToolCall`). `ORDER BY started_at DESC LIMIT
  1` so a resume's newer stream wins — this is the "re-target on resume".

**Renderer (deliberately self-contained — NOT the global Redux streaming slice).**
`useSubagentByToolCall` returns `{ runs, streamId }`. New `useSubagentLiveStream`
hook `fetch`-subscribes `GET /streams/:streamId?fromSeq=0`, parses the SSE frames
(`{...event, seq}`), accumulates the in-progress turn's text/reasoning, and on each
`assistant_message_persisted` (turn boundary) + the terminal `complete`/`error`
invalidates the `['subagents','by-tool-call',toolCallId]` query so finished turns
fold into the persisted transcript. `SubagentTranscriptModal` subscribes only while
a run is `running`, shows a "Live" pulse + a streaming tail, and re-targets
automatically when `streamId` changes (resume). A 410 (session reaped) just resolves
`done`. **Why not the Redux path the plan sketched:** projecting subagent
`started`/`complete` through the main `projectServerEvent` risks hijacking
`conversation.currentLineageId` (chatSlice `streamLineageUpdated`) and hits the
`started` `parentId` guard / optional-`complete.message` mismatches the recon
flagged — a modal-local subscription is isolated, can't disturb the main chat view,
and delivers the same result. The dormant `selectChildStreams` /
`selectActiveSubagentStreams` and the `heimdall.subagentMap` tombstone were left
untouched.

**Verified:** `tsc -b` clean; 0 new electron tsc errors. Route test asserts the
`streamId` in the response; new service test asserts a background run publishes
`started → complete` into its session (fake registry). Full headless suite: 304
pass / 2 pre-existing fail / 62 skip.

---

## Verification environment (IMPORTANT)

- Node here is **v26 (ABI 147)**; `better-sqlite3` is compiled for **Electron's ABI
  (139)** → the sqlite-backed vitest suites **self-skip** (`describeIfSqlite`). This is
  pre-existing/by-design. Rebuild for Electron with `npm run rebuild:client`.
- **Repo-layer (Phase 0)** was therefore verified against Node's built-in `node:sqlite`
  by driving the REAL `SubagentRunRepo` (Node strips TS types on import): 23/23 checks
  incl. lineage isolation; migration idempotency validated separately. (Harness was a
  throwaway in the session scratchpad — recreate if needed.)
- **Service-layer (Phase 1)** tests use pure-JS fakes (no sqlite) so they RUN under
  vitest: `npx vitest run --config vitest.headless.config.ts subagentRunService`.
- Test scripts: `npm run test:headless` (vitest.headless.config.ts),
  `npm run test:tools`. Electron code is bundled via esbuild (NO tsc typecheck in the
  standard build); `tsc -b` only covers `src` + `shared`.

**Known pre-existing failures (NOT from this work)** — both fail at HEAD with all
subagent-manager changes stashed, both stem from `filterToolsForOperationMode` behavior
having changed (in the checkpointed lineage/fork WIP) without the tests being updated:
1. `subagentRunService.test.ts > "filters mcp tools out of the tool set in plan mode"`
   — expects `mcp__*` dropped in plan mode; it no longer is.
2. `operationModeSystemPrompt.test.ts > "exposes bash and powershell in plan mode"`
   — expects `edit_file` filtered out in plan mode; it no longer is.
Decide separately whether to fix the tests or the behavior.

---

## Remaining phases (specifics for resuming)

### Phase 2 — `subagent_manager` tool (executor-layer interceptor)
- Compose/extend `createSubagentDispatchExecutor`
  (`electron/headlessServer/services/subagentToolExecutor.ts`) into a manager
  interceptor with actions **`spawn(blocking?)` / `list` / `status(handle)` /
  `cancel(handle)` / `resume(handle)`**, all reading the full `ToolExecutionContext`.
- Wire in `electron/headlessServer/index.ts` (~304-346 where `SubagentRunService` +
  `createSubagentDispatchExecutor` are constructed). Uses `spawnDetached`/`cancel`
  from Phase 1.
- Register `subagent_manager` in the built-in whitelist (`index.ts`
  `HEADLESS_RUNTIME_BUILTIN_TOOL_NAMES` ~44-78 + shared `BUILTIN_TOOL_DEFINITIONS` +
  renderer `src/features/chats/toolDefinitions.ts` ~:298). **Exclude it from the
  subagent child tool set** (no nesting).
- Ownership: every read/action re-checks `run.lineage_id === ctx.lineageId &&
  run.conversation_id === ctx.conversationId`. `list`/`status` return a `resumable`
  flag + handles + terminal runs (use `listByLineage`).
- **Must-have test:** branch-A vs branch-B in the SAME conversation → each `list`
  sees only its own runs (the isolation guarantee).

### Phase 3 — In-loop provider-error retry
- New retry INSIDE `generateProviderTurn` (`toolLoopService.ts` ~489-612): attempt loop
  around `providerRouter.generate`; **defer** the error-row persistence until attempts
  exhausted (currently persists+throws at ~580-593); do NOT advance the turn counter;
  abort-aware backoff via `abortAwareSleep` (~244-264); rethrow `AbortError`.
- Provider-agnostic transient classifier: reuse status/keyword set from
  `providerErrorFormatter.ts` ~75-84 (429/408/≥500/overloaded/usage-limit/timeout) but
  DROP the OpenAI-only gate (subagents run on zai/bedrock/openrouter).
- Config: add `retryProviderError? / maxProviderRetries?(~2) / providerRetryBackoffMs?`
  to `ToolLoopRobustnessOptions` (~73-82); set at `subagentRunService.ts` (the
  `robustness:{...}` in `driveRun`'s `loop.run` input). Emit `provider_retry` SSE status
  (extend the `tool_loop` union in `contracts/headlessApi.ts` ~160).
- Note: `run()`/subagents already opt into `robustness` (empty-turn retry +
  finalization); MAIN chat loop opts into none. The provider-ERROR retry is net-new.

### Phase 4 — Resume (`subagent_manager.resume(handle)`)
- No true resume exists today (only reattach-to-live + DecisionBroker tool-approval
  resume). Net-new, built on durable rows.
- Steps: resolve handle→run; ownership re-check; status gate via `reopenRun` (CAS);
  **rebuild history** = feed `runRepo.getMessages(runId)` as the loop `history` instead
  of the synthetic single user turn (`subagentRunService.ts` ~`history:[{role:'user'...}]`);
  **repair dangling tool_use** (scan tail assistant row, synthesize `{is_error:true,
  content:'<interrupted…>'}` via `updateMessageToolState`, never re-execute — OpenAI
  Responses rejects an unmatched function_call, see `codexRequestItems.ts` pairing);
  compaction trim from persisted `__auto_compaction_summary__` marker; budget recount
  from assistant-row count (turns_used is 0 on crash); reopen same runId + NEW streamId
  + SAME handle + NEW AbortController.
- **Startup reconciler:** sweep orphaned `status='running'` rows → `error`+resumable
  (no `finally` today; crashes leave rows stuck at running). Pair with persisted handle
  resolution so crash victims resume across a process restart.

### Phase 5 — UI: persisted transcript viewer
- Server: `GET /api/subagents/by-tool-call/:toolCallId` (repo `listByToolCall` exists) →
  run + transcript + child streamId.
- Renderer: shared `SubagentRunRow` type; `useSubagentByToolCall` hook +
  `subagentQueryKeys` (model on `useLocalTopLevelUserMessages`, `useQueries.ts` ~473);
  extract Heimdall block renderer (`Heimdall.tsx` ~4838-4996) → `<SubagentTranscript/>`;
  add `isSubagent` branch + `renderSubagentTranscriptButton(group.id)` in
  `renderToolCallGroupCard` (`ChatMessage.tsx` ~1656 / button row ~2106, mirror
  `renderHtmlViewerButton` ~1559); `onOpenSubagentTranscript` prop + `Chat.tsx` handler
  (~5959) + global modal (`App.tsx` ~140).
- **Status chip MUST come from `run.status`, not the card's result-derived class**
  (`ChatMessage.tsx` ~1900-1902) — async result is a handle, so the card would show
  "success" while still running.
- Optional: handle chip + Cancel button (async only).

### Phase 6 — UI: live streaming
- Server: register subagent runs in the `RunSessionRegistry` so the existing
  `/api/streams/:streamId?fromSeq` serves them (today `subagentRoutes.ts` ~66 is
  disconnect==abort and doesn't register → `/api/streams/:id` 410s).
- Renderer: subagent-aware cases in `projectServerEvent` (`sseProjection.ts` ~268 drops
  them today); add `toolCallId` to `StreamState`/`StreamLineage` (`chatTypes.ts`
  ~159-205) + `selectSubagentStreamByToolCall`; viewer subscribes when `status==='running'`
  via `pump()` (`mainChatClient.ts` ~120), flips to persisted on `complete`,
  **re-targets the new streamId after a resume**.
- Reuse: `sendingStarted({streamType:'subagent'})`, streamChunk/complete reducers,
  the dormant `selectChildStreams`/`selectActiveSubagentStreams` selectors.
- **Do NOT build on tombstones:** `heimdall.subagentMap` (always `{}`),
  `selectHeimdallSubagentMap`, and the `ex_agent`/`persistent_agent` filter (retired
  global agent, unrelated).

---

## Key file map

| Concern | File |
|---|---|
| Schema / statements | `electron/localServer.ts` |
| Subagent repo | `electron/headlessServer/persistence/subagentRunRepo.ts` |
| Spawn engine | `electron/headlessServer/services/subagentRunService.ts` |
| Dispatch → manager interceptor (Phase 2) | `electron/headlessServer/services/subagentToolExecutor.ts` |
| Wiring / tool whitelist | `electron/headlessServer/index.ts` |
| Renderer tool defs | `src/features/chats/toolDefinitions.ts` |
| Loop / retry (Phase 3) | `electron/headlessServer/services/toolLoopService.ts` |
| Provider error classify | `electron/headlessServer/providers/providerErrorFormatter.ts` |
| SSE contract | `electron/headlessServer/contracts/headlessApi.ts` |
| UI tool card / viewer | `src/components/ChatMessage/ChatMessage.tsx`, `src/components/Heimdall/Heimdall.tsx` |
| UI wiring | `src/containers/Chat.tsx`, `src/App.tsx`, `src/hooks/useQueries.ts` |
| SSE→Redux projection | `src/features/chats/sseProjection.ts`, `mainChatClient.ts`, `chatTypes.ts` |
