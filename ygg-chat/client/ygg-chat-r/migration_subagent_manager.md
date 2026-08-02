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
| 1 | Spawn engine (blocking + async) | ✅ done | **uncommitted** at last update (service + its test) |
| 2 | `subagent_manager` tool (executor-layer interceptor) | ⬜ next | unblocked |
| 3 | In-loop provider-error retry | ⬜ pending | independent of 1/2 |
| 4 | Resume (`subagent_manager.resume`) | ⬜ pending | needs 0+1+2 |
| 5 | UI: persisted transcript viewer | ⬜ pending | needs 0 |
| 6 | UI: live streaming | ⬜ pending | needs 5 |

**Recommended slice for a usable v1:** 0 → 1 → 2 → 5. Then 3 (fewer failures),
4 (recover failures), 6 (live progress).

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

**Known pre-existing failure (NOT from this work):** `subagentRunService.test.ts >
"filters mcp tools out of the tool set in plan mode"` fails at HEAD (`8241cd7`) too —
`filterToolsForOperationMode` no longer drops `mcp__*` in plan mode but the test still
expects it to. Decide separately whether to fix the test or the behavior.

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
