---
paths:
  - "client/ygg-chat-r/server/tools/glob.ts"
---

# `glob.ts` tool documentation

## Purpose

The `client/ygg-chat-r/electron/tools/glob.ts` module wraps the `glob` package and exposes a single reusable async API (`globSearch`) tailored to Electron/WSL usage within Yggdrasil. It enforces workspace safety, default ignore patterns, match limits, and timeout controls while also normalizing paths between Windows and WSL environments.

## Key safeguards and utilities

1. **Workspace guards**
   * `ensureWithinWorkspace(cwd)` converts the requested `cwd` into a resolved path, resolves Linux-style paths to Windows UNC paths when running on Windows, and stops searches from accidentally running from the system root or the user home directory unless explicitly desired.
   * `detectPathType`, `isWindows`, `resolveToWindowsPath`, and `toWslPath` are borrowed from `../utils/wslBridge.js` to keep path handling consistent.

2. **Default constants**
   * `DEFAULT_IGNORE_PATTERNS` excludes common build output and dependency directories (e.g., `node_modules`, `.git`, `dist`, `build`, coverage folders, etc.) plus `*.min.js` files to avoid scanning generated assets.
   * `DEFAULT_MAX_MATCHES` (3,000) and `DEFAULT_TIMEOUT_MS` (5,000 ms) defend against runaway queries.
   * `DIRECTORY_DEPTH_LIMIT` (6) keeps patterns from exploring arbitrarily deep directories.

3. **Supporting helpers**
   * `mergeIgnorePatterns` combines default ignore patterns with optional custom ones supplied by the caller, eliminating duplicates.
   * `enforcePatternDepth` truncates a glob pattern to four segments to avoid deep enumeration.

## `globSearch(pattern, options)`

### Input validation
* Returns an error if `pattern` is empty or whitespace.

### Supported options (all optional, with defaults)
* `cwd` – directory from which to run the glob (defaults to `process.cwd()` after being normalized). Supports both Windows and WSL paths.
* `ignore` – additional glob patterns or a string of patterns to exclude from results.
* `dot`, `absolute`, `mark`, `nosort`, `nocase`, `nodir`, `follow`, `realpath`, `stat`, `withFileTypes` – forwarded directly to the underlying `glob` implementation.
* `maxMatches` – overrides the default cap (3,000).
* `timeoutMs` – overrides the default timeout (5,000 ms).

### Execution flow
1. Performs safety checks on the provided working directory via `ensureWithinWorkspace`.
2. Sanitizes the pattern depth and merges ignore patterns.
3. Prepares glob options, including `windowsPathsNoEscape: true` to keep Windows-style characters literal.
4. Launches the glob search using `glob()` with a `Promise.race` that rejects if the timeout is reached.
5. If successful, it maps directory entries to string paths when `withFileTypes` is set.
6. If too many matches are found (more than `maxMatches`), the function returns an error describing the situation and includes the resolved cwd and sanitized pattern.

### Output structure
* `success` – boolean indicating whether the search succeeded.
* `matches` – array of matching path strings (or derived from `Dirent` objects when `withFileTypes` is `true`).
* `error` – optional error message when the operation fails or is limited.
* `pattern` – sanitized pattern used during the attempt.
* `cwd` – normalized path used for the search.

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
