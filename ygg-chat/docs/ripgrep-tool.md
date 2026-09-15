---
paths:
  - "client/ygg-chat-r/server/tools/ripgrep.ts"
---

# `ripgrep.ts` (Electron Tool) Documentation

## Purpose
`ripgrep.ts` is an Electron helper that wraps the [ripgrep (`rg`)](https://github.com/BurntSushi/ripgrep) CLI to power the Ygg-Chat Electron app with fast, configurable file searching. It exposes the `ripgrepSearch` async helper, which runs `rg` with safe defaults, post-processes the output, enforces throttling limits, and normalizes cross-platform path handling.

## API Surface
| Name | Description |
| --- | --- |
| `ripgrepSearch(pattern, searchPath = '.', options = {})` | Performs a search. Returns a promise that resolves to a `RipgrepResult`. |
| `RipgrepOptions` | Controls rg behavior: case sensitivity, line numbers, glob filters, hidden file handling, ignore rules, context lines, and limits (`maxCount`, `maxOutputChars`). |
| `RipgrepResult` | Contains `success`, an array of match objects (`file`, optional `lineNumber`, `line`, and `matchCount`), and any `error` or `command` metadata. |

## Execution Flow
1. **Path Resolution**
   - Uses `resolveSearchPath` to clean input and decide whether to run inside WSL on Windows. If WSL is needed, paths are converted to the WSL format via `toWslPath`, and the `getWSLCommandArgs` helper wraps `rg` execution accordingly.
   - On macOS/Linux the path is resolved to an absolute path using `path.resolve`.

2. **Command Construction**
   - Basic args: pattern, target directory.
   - Flags are added based on `RipgrepOptions`: `-i`/`-s`, `-n`, `-c`, `-l`, `-m`, `-g`, `--hidden`, `--no-ignore`, and `-C`.
   - JSON output (`--json`) is always requested except for count/files-with-matches modes.

3. **Execution**
   - Spawns `rg` (or WSL proxy) via `child_process.spawn`. Output is collected from `stdout`/`stderr`. Errors resolve the promise with helpful messaging.
   - A 30-second timeout aborts the search to prevent hanging.

4. **Limits & Throttling**
   - `DEFAULT_MAX_OUTPUT_CHARS` (configurable via `RIPGREP_MAX_OUTPUT_CHARS`/`RIPGREP_OUTPUT_LIMIT`) caps total chars returned (default 10,000).
   - Hard limits: at most 5,000 match objects (`MAX_RESULT_LINES`) and individual lines truncated to 1,000 characters (`MAX_LINE_LENGTH`).
   - If limits are exceeded, the search rejects with guidance on narrowing scope.

5. **Output Parsing**
   - JSON mode lines are parsed, extracting file, line number, and text.
   - Fallback parsing handles `-c` (count) and `-l` (files with matches) output formats, as well as plain text lines.
   - Each match gets normalized to a consistent shape for Electron consumers.

6. **Result**
   - Returns `RipgrepResult` containing: `success: true` and normalized matches on success, or `success: false` with `error` details and the executed `command` string when issues occur.

## Error Handling & Reliability
- Detects ripgrep execution failures (`child.on('error')`) and surfaces clear instructions (e.g., ensure `rg` is installed).
- Handles `rg` exit codes: `0` = matches, `1` = no matches (still resolved as success), `2` = error (captures `stderr`).
- Wraps JSON parsing in a `try/catch`; falls back to simple regex parsing when necessary.

## Cross-Platform Notes
- Uses `shouldUseWSL` to avoid incorrectly invoking native `rg` on Windows when the environment requires WSL paths.
- `getWSLCommandArgs` ensures the correct executable and arguments are used when the Electron app is shipped on Windows while still relying on the Linux `rg` binary.

## Summary Tips for Contributors
- Keep default limits in mind when adjusting `RipgrepOptions` via Electron UI or remote calls.
- Any new search modes must still respect line length/total char limits to avoid overwhelming downstream consumers.
- When running locally, remember to install `ripgrep` so the tool can execute successfully.
