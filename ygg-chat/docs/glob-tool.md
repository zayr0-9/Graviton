---
paths:
  - "client/ygg-chat-r/server/tools/glob.ts"
---

# `glob.ts` tool documentation

## Purpose

The `client/ygg-chat-r/server/tools/glob.ts` module exposes `globSearch` for Electron/WSL searches. Tool registration validates workspace scope before calling it. The helper resolves native paths, applies default ignores, and bounds traversal by match count, cancellation, and elapsed time.

## Key safeguards and utilities

1. **Workspace guards**
   * `resolveGlobCwd` resolves native paths and converts Linux-style paths on Windows to native UNC paths. Node globbing must retain the UNC path, not convert it back to a Linux path.
   * Workspace containment is enforced by the built-in tool registries, not by a root/home-directory restriction inside `globSearch`.

2. **Default constants**
   * `DEFAULT_IGNORE_PATTERNS` excludes common build output and dependency directories (e.g., `node_modules`, `.git`, `dist`, `build`, coverage folders, etc.) plus `*.min.js` files to avoid scanning generated assets.
   * `DEFAULT_MAX_MATCHES` (3,000) and `DEFAULT_TIMEOUT_MS` (5,000 ms) defend against runaway queries.
   * The existing `DIRECTORY_DEPTH_LIMIT` (6) truncates literal pattern segments; it does not bound the traversal depth of `**`.

3. **Supporting helpers**
   * `mergeIgnorePatterns` combines default ignore patterns with optional custom ones supplied by the caller, eliminating duplicates.
   * `enforcePatternDepth` retains the existing six-segment pattern limit.

## `globSearch(pattern, options)`

### Input validation
* Returns an error if `pattern` is empty or whitespace.

### Supported options (all optional, with defaults)
* `cwd` – directory from which to run the glob (defaults to `process.cwd()` after being normalized). Supports both Windows and WSL paths.
* `ignore` – additional glob patterns or a string of patterns to exclude from results.
* `dot`, `absolute`, `mark`, `nosort`, `nocase`, `nodir`, `follow`, `realpath`, `stat`, `withFileTypes` – forwarded directly to the underlying `glob` implementation.
* `maxMatches` – overrides the default cap (3,000).
* `timeoutMs` – overrides the default timeout (5,000 ms); invalid/non-positive values use the default, positive values are bounded to 1–600,000 ms.
* `signal`, `deadlineMs` – internal execution cancellation and epoch deadline forwarded by both tool registries. The earlier of the timeout and caller deadline wins; preparation consumes the same budget.
* With `withFileTypes`, `absolute` is omitted because the glob package rejects that combination; output remains string full paths.

### Execution flow
1. Checks pre-cancellation/deadline and arms one deadline timer before resolving the cwd.
2. Resolves native cwd, sanitizes the pattern, and merges ignore patterns.
3. Passes an invocation-owned AbortSignal and `windowsPathsNoEscape: true` to `glob.iterate`.
4. Consumes matches incrementally; exceeding the match cap aborts the walk immediately rather than collecting the whole tree.
5. Timeout or caller cancellation aborts traversal and settles the caller even if preparation or a filesystem operation is unresponsive. Late preparation cannot start a new walk.
6. Clears the timer and caller abort listener on every exit. In-flight OS filesystem calls may still finish after abort.

### Output structure
* `success` – boolean indicating whether the search succeeded.
* `matches` – array of matching path strings (or derived from `Dirent` objects when `withFileTypes` is `true`).
* `error` – optional error message when the operation fails or is limited.
* `pattern`, `cwd` – resolved/sanitized on success; original inputs on failure.
* `timedOut`, `cancelled` – additive flags on the corresponding failure. Failure results contain no partial matches.

### Failure handling
* Gracefully captures timeouts, glob failures, type mismatches, and excessive match counts to avoid unhandled rejections.

### Example usage
```ts
import globSearch from './tools/glob'

const result = await globSearch('**/*.ts', { cwd: '/home/project', dot: true })
if (!result.success) {
  console.error(result.error)
}
```

## Summary
`glob.ts` centralizes globbing logic for Electron/WSL contexts in the client, providing safety checks, default ignores, match/time limits, and consistent path handling, making it safe and predictable to search for files programmatically within the workspace.
