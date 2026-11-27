---
paths:
  - "client/ygg-chat-r/server/headlessServer/services/replExecutor.ts"
  - "client/ygg-chat-r/server/headlessServer/services/replScript.ts"
  - "client/ygg-chat-r/server/headlessServer/services/__tests__/replExecutor.test.ts"
---

# REPL tool

`repl` is a server-owned composite tool for capturing tool results and processing them without automatically putting the data into model context. Existing tools remain available directly.

## Workflow

The tool definition includes the complete workflow guide, examples, output budgets, state lifetime and safety rules. Call `{"howto":true}` to retrieve the identical guide later in the conversation. No `action` is needed. Help is read-only and does not create or change session state; when `howto:true` accompanies other fields it returns help instead of executing them. The shared source is `shared/replGuide.ts`.

```json
{"action":"invoke","tool":"read_file","args":{"path":"package.json"},"assign":"file"}
```

Returns only `{ "status": "stored", "variable": "file", "totalChars": 1234, "toolStatus": "success" }` plus the workspace receipt. `totalChars` matches what `show` would report for the variable (raw length for strings, compact JSON length otherwise); conflict and import receipts include it too. The underlying result stays in session memory.

```json
{"action":"inspect","variable":"file"}
```

Returns type, length or up to 30 property names, not the full value.

```json
{"action":"exec","code":"var manifest = JSON.parse(file.content); var names = Object.keys(manifest.dependencies);"}
```

`exec` runs synchronous JavaScript inside QuickJS WebAssembly. Use **top-level `var`** for persistent, inspectable bindings. `let`/`const` are JavaScript lexical bindings and are not included in the variable inventory. Completion values are discarded. There is no console, Node, filesystem, network, or import loader. Default `exec` cannot call tools; use `invoke` or opt in to async exec.

```json
{"action":"show","variable":"names","maxOutputChars":4000}
```

To combine processing and disclosure in one call, pass an optional variable name in `show`:

```json
{"action":"exec","code":"var names = Object.keys(manifest.dependencies);","show":"names","maxOutputChars":4000}
```

Omit `show` to keep `exec` silent. `show` accepts a top-level variable identifier, not an expression or boolean. Execution and disclosure run in the same queued cell, so sibling operations cannot interleave. The combined response includes `success: true`, `status: "executed"`, `variable`, the usual show fields, and the workspace receipt. It uses the same `offset` and `maxOutputChars` limits as standalone `show`; continue truncated output with standalone `show` to avoid rerunning code. Invalid disclosure parameters are rejected before code runs. If code fails, disclosure is skipped. If disclosure fails after code succeeds, the error explicitly says execution completed and state changes remain; inspect/show the value without rerunning exec.

Strings display directly; other values use JSON. Responses include `totalChars`, `truncated`, and `nextOffset`. Continue with `offset`. `list`, `drop` (requires `variable`), and `reset` manage state. Replacing an existing variable through `invoke` requires `overwrite: true`.

## Async exec: dependent read-only tool calls

```json
{"action":"exec","async":true,"code":"const files = await tools.call('glob', {pattern:'*.json'}); if (!files.matches?.length) return null; const file = await tools.call('read_file', {path: files.matches[0], maxBytes: 4000}); return file.content;","assign":"sample"}
```

Async scripts run in a fresh QuickJS runtime. They cannot access existing branch variables and their local bindings do not persist. Set `assign` to save a plain JSON `return` value (up to 5 MiB); use `inspect` or `show` separately. Without `assign`, the result is discarded. `show` in the same call is not supported. Destination reservations, `overwrite:true`, and `resultVariable` for overwrite conflicts work as with `invoke`.

`tools.call(name, args)` supports only `read_file`, `glob`, and `ripgrep`, subject to the caller's allowlist and the same nested dispatch as `invoke`. Calls have unique IDs for approvals and events. Await them sequentially: up to eight calls, with a 64 KiB plain JSON argument limit per call. Tool result objects are returned as-is within the normal bounded capture format; thrown dispatch errors stop the script. Raw data is not emitted as a transcript result. There is no shell, write, batch, subagent, or recursive REPL access in scripts.

The JavaScript budget covers all execution steps, not tool or approval waits. At most four scripts run per dispatcher, including scripts waiting for approval; each has its own 32 MiB guest heap. The shared workspace is not locked while scripts await tools. As with `invoke`, nested reads can trigger lazy project instructions and authorized hook context; those are separate from the captured tool results. Stop cancels the script and prevents any late result from being written. No script survives a single exec call.

## Manual JSON export and import

```json
{"action":"export","variable":"benchmarkResults","path":"benchmarks/results/run-001.json"}
{"action":"import","path":"benchmarks/results/run-001.json","assign":"benchmarkResults"}
```

Export snapshots one variable and dispatches `create_file` through the normal permission/hook boundary. It requires Agent mode and `create_file` availability. Import uses `read_file` and is permitted in Chat mode. Both return metadata, not payloads; there is no model-mediated copying. Existing files or import destinations require `overwrite:true`. Export creates parent directories. File-tool workspace/managed-path rules still apply.

Artifacts are plain JSON, limited to 5 MiB UTF-8, depth 64 and 100,000 value nodes, plus QuickJS CPU/memory limits. Supported: null, strings, booleans, finite numbers, dense arrays and plain data objects. Unsupported values, sparse/extra-property arrays, cycles, accessors, symbols, non-enumerable data properties and custom prototypes are rejected, not silently omitted. The serializer does not call getters or `toJSON`; guest proxies can still execute reflection traps within the sandbox deadline. JSON does not preserve shared-reference identity or negative zero. Strings are JSON-encoded, not raw text files.

Import rejects truncated reads and invalid/oversized JSON before replacing the destination; parser errors do not quote file contents. It reserves the destination during I/O and retains parsed conflict results under `resultVariable` rather than overwriting sibling changes. Cancellation releases reservations and prevents late installation. Export snapshots inside a cell but releases the lock for filesystem I/O; its receipt reports the snapshot revision, not necessarily the latest workspace revision.

This is manual data persistence, not a VM checkpoint: export before shutdown and explicitly import after restarting. `reset`/`drop` do not delete artifacts. Failed/cancelled writes may have side effects; inspect the file before retrying. Artifacts are plaintext; select their contents deliberately and avoid accidentally committing sensitive files. Normal tool jobs and hooks still see their usual payloads; authorized hooks may independently add context. No new database or automatic replay is involved.

## Routing and permissions

The dispatcher intercepts `repl` before ordinary tool jobs. Each invoke uses the server-owned `context.nestedExecutor`, preserving permissions, hooks, mode policy, cancellation and execution events. It fails closed without that callback or the caller's tool allowlist. The outer tool result contains only the receipt; nested results are not appended to provider history. Explicit `show` (standalone or the optional `exec` parameter) is the disclosure boundary. Hooks may independently contribute authorized context.

Nested file calls still trigger lazy project instruction loading in the main loop. No new model provider integration is required. MCP tools work when discovered and available to the invoking run; custom tools can be invoked through the existing `custom_tool_manager`.

This does **not** suppress existing tool-job persistence or hook processing. It prevents automatic result injection into the model, not all storage of those results.

## Isolation and limits

- Ownership: conversation + verified branch lineage + filesystem root. Parent and child/sibling agents on that branch share the same variables. Agent run IDs identify writers, not separate namespaces. Direct HTTP subagent requests ignore supplied lineage and use private run-ID workspaces; parent tool dispatch and owned manager resume carry the trusted branch identity.
- Sharing exposes all branch data to children regardless of their tool permissions. Permissions still govern each child's future invocations. Arbitrary exec can change shared evidence, so coordinate destination names and preserve provenance.
- No cross-branch variable inheritance and no automatic replay after restart.
- Memory-only sessions expire on next access after 30 minutes idle or on server restart. Up to 16 sessions per dispatcher; idle expired sessions are reclaimed on subsequent REPL requests.
- Each session has a separate QuickJS WASM module/runtime and a 32 MiB guest heap limit, plus engine overhead. Each stored JSON result is capped at 8 MiB.
- State cells queue FIFO (up to 64 waiting). Captures briefly reserve their destination, execute tools outside the queue, then queue storage. Up to 16 captures may run concurrently. A parent capturing a child wait cannot block the child's exec cells.
- Receipts include workspace revision and lastWriter. Concurrent independent captures into different absent names succeed. Intervening exec/drop or guest inspection during an overwrite conservatively produces status:conflict; the original destination remains and the tool result is retained under resultVariable. Use that variable rather than replaying side effects.
- Only the parent may reset a shared branch; standalone private children can reset their own scope. Reset is rejected while captures are in flight. Drop refuses a reserved destination. Failed exec cells can mutate shared state and also advance revision/conflict detection.
- `exec`: up to 32,000 code characters; interrupt deadline defaults to 100 ms, maximum 250 ms. QuickJS runs synchronously on the host thread; interruption is cooperative, not a separate OS-worker termination guarantee.
- `show`: default 4,000 output characters, maximum 20,000, plus metadata. Inspection JSON is separately bounded.
- Tool calls retain their normal deadlines. Aborting a capture promptly releases its reservation even if the underlying tool ignores cancellation; late results are not stored. Cancellation does not prove side effects stopped and cannot roll back completed effects.

## Errors and special tools

Tool failures are stored as values and signalled with `toolStatus: "error"`; use `show` to inspect. Cancellation propagates rather than becoming a successful stored error. Storage/serialization failures explicitly report that the tool may already have executed: **never retry mutations blindly**. Failed JavaScript cells can also leave partial variable changes.

`invoke` can capture one `multi_call` batch into a variable:

```json
{"action":"invoke","tool":"multi_call","args":{"calls":[{"tool":"read_file","args":{"path":"package.json"}},{"tool":"glob","args":{"pattern":"*.md"}}],"parallel":true},"assign":"batch"}
```

The receipt describes the capture, not individual successes. Inspect `batch.results` for ordered per-tool data, errors and skips. Normal batch limits, caller allowlists, per-tool approval, hooks and mode checks still apply. A captured batch cannot contain another batch or a REPL call. Direct `multi_call` can still include REPL calls as long as they do not invoke another batch.

Use `repl`, `skill_manager`, `html_renderer`, `view_image`, `switch_mode`, and `plan_md` display directly rather than capturing them, including inside a captured batch. For other split-channel outputs, single captures store only `persistedContent`/`displayContent` and report `metadataOnly: true`; batches keep the normal per-item result shape without ephemeral `modelContent`.

No new subagent recursion is enabled. The existing parent-only subagent dispatcher remains the boundary. There is no general-purpose tool-call bridge, artifact viewer, notebook UI, restart checkpoint, or transaction rollback.

## Implementation

- `client/ygg-chat-r/server/headlessServer/services/replExecutor.ts`: persistent sessions, actions, nested dispatch.
- `client/ygg-chat-r/server/headlessServer/services/replScript.ts`: isolated async execution and bounded tool bridge.
- `client/ygg-chat-r/server/headlessServer/services/toolLoopService.ts`: caller tool allowlist and lazy instruction propagation.
- `client/ygg-chat-r/server/headlessServer/services/subagentRunService.ts`: trusted branch propagation, child attribution and restricted tool set.
- `client/ygg-chat-r/server/headlessServer/routes/subagentRoutes.ts`: direct HTTP children stay privately scoped.
- `shared/builtinToolDefinitions.ts`: canonical schema.
- `client/ygg-chat-r/server/headlessServer/index.ts` and `src/features/chats/toolDefinitions.ts`: runtime composition and model visibility.

QuickJS dependencies use a single-file WASM variant so Electron/standalone bundles do not require a separately copied `.wasm` file. Existing ESM bundles must retain their `createRequire` banner.

## Validation

From `client/ygg-chat-r`:

```sh
npm run typecheck:server
npm run typecheck:electron
npm run test:headless -- server/headlessServer/services/__tests__/replExecutor.test.ts server/headlessServer/services/__tests__/toolLoopService.test.ts server/headlessServer/services/__tests__/multiCallExecutor.test.ts server/headlessServer/services/__tests__/subagentRunService.test.ts server/headlessServer/services/__tests__/operationModeControl.test.ts
```

Manual desktop checks: visibility in tool settings/model schemas, invoke/inspect/exec/show across turns, nested denial, Stop during a tool call, isolated branches, shared parent/subagent operations, parent wait with child exec, conflicting capture recovery, and parent-only session reset. Packaged Electron runtime still needs a desktop smoke test.
