---
paths:
  - "client/ygg-chat-r/server/tools/ripgrep.ts"
---

# `ripgrep.ts` (Electron Tool) Documentation

## Purpose
`ripgrep.ts` is an Electron helper that wraps the [ripgrep (`rg`)](https://github.com/BurntSushi/ripgrep) CLI to power the Ygg-Chat Electron app with fast, configurable file searching. It exposes the `ripgrepSearch` async helper, which runs `rg` with safe defaults, post-processes the output, enforces throttling limits, and normalizes cross-platform path handling.

## Public schema versus helper

The shared schema advertises older 500-match / 5000-character / 500-character-line
limits; actual helper limits are below. `maxOutputChars`/`timeoutMs` are internal
or registry-supported, not public schema properties. The helper defaults to
case-insensitive, but both registries default omitted `caseSensitive` to true
unless legacy `case_insensitive` is true. Pass `caseSensitive` explicitly.

## API Surface
| Name | Description |
| --- | --- |
| `ripgrepSearch(pattern, searchPath = '.', options = {})` | Performs a search. Returns a promise that resolves to a `RipgrepResult`. |
| `RipgrepOptions` | Controls rg behavior: case sensitivity, line numbers, glob filters, hidden file handling, ignore rules, context lines, and limits (`maxCount`, `maxOutputChars`). |
| `RipgrepResult` | Contains `success`, an array of match objects (`file`, optional `lineNumber`, `line`, and `matchCount`), and any `error` or `command` metadata. Timeout/cancellation adds `timedOut`/`cancelled`. |

Internal options `signal`, `deadlineMs` and `timeoutMs` are forwarded by both tool registries. Default budget remains 30 seconds; preparation is included, and an earlier epoch deadline wins. Positive timeout overrides use the shared runner's 180-second cap. Invalid/non-positive values use 30 seconds. This does not change Settings or SSE timeouts.

## Execution Flow
1. **Path Resolution**
   - Uses `resolveSearchPath` to clean input and decide whether to run inside WSL on Windows. If WSL is needed, paths are converted to the WSL format via `toWslPath`, and the `getWSLCommandArgs` helper wraps `rg` execution accordingly.
   - On macOS/Linux the path is resolved to an absolute path using `path.resolve`.

2. **Command Construction**
   - Pattern is passed using `-e`; the target follows `--`, so leading dashes cannot turn either into command options.
   - Flags are added based on `RipgrepOptions`: `-i`/`-s`, `-n`, `-c`, `-l`, `-m`, `-g`, `--hidden`, `--no-ignore`, and `-C`.
   - JSON output (`--json`) is always requested except for count/files-with-matches modes.

3. **Execution**
   - Uses the existing `runBoundedShell` process lifecycle, not a shell for native rg. It preserves macOS/Linux login-shell PATH discovery and prefers native Windows rg when available.
   - Timeout/cancellation settles after at most the shared 300ms execution cleanup grace, without requiring child `close`. Cleanup is best effort; timers, stream listeners and caller abort listeners are released.
   - WSL execution uses an invocation-owned `setsid` group and positional rg arguments. An unresponsive distro can prevent process cleanup, but not bounded result settlement. Windows executable discovery is bounded and does not cache cancelled in-flight promises.

4. **Limits & Throttling**
   - Raw stdout plus stderr is capped at 200,000 characters during collection, before JSON parsing. Overflow is reported as failure, never successful partial matches. Excess bytes are discarded while the bounded process runs.
   - `DEFAULT_MAX_OUTPUT_CHARS` (configurable via `RIPGREP_MAX_OUTPUT_CHARS`/`RIPGREP_OUTPUT_LIMIT`) caps returned match text or filenames (default 40,000).
   - Hard limits: at most 5,000 match objects (`MAX_RESULT_LINES`) and individual lines truncated to 1,000 characters (`MAX_LINE_LENGTH`).
   - If limits are exceeded, the search returns `success:false`, empty matches, and guidance on narrowing scope.

5. **Output Parsing**
   - JSON `match` and `context` records are parsed, extracting file, line number, and text. Count parsing splits at the final numeric suffix so Windows drive letters are preserved.
   - Fallback parsing handles `-c` (count) and `-l` (files with matches) output formats, as well as plain text lines.
   - Each match gets normalized to a consistent shape for Electron consumers.

6. **Result**
   - Returns `RipgrepResult` containing: `success: true` and normalized matches on success, or `success: false` with `error` details and the executed `command` string when issues occur.

## Error Handling & Reliability
- Detects ripgrep execution failures (`child.on('error')`) and surfaces clear instructions (e.g., ensure `rg` is installed).
- Only exit codes `0` and `1` are successful. Other codes, signal termination, timeout and cancellation return failure with empty matches. No partial timeout output is presented as a complete search.
- Invalid JSON records are skipped by per-record catches. Plain-text fallback exists only in the outer parser catch; malformed records do not reliably trigger it.

## Cross-Platform Notes
- Uses `shouldUseWSL` to avoid incorrectly invoking native `rg` on Windows when the environment requires WSL paths.
- `getWSLCommandArgs` ensures the correct executable and arguments are used when the Electron app is shipped on Windows while still relying on the Linux `rg` binary.

## Summary Tips for Contributors
- Keep default limits in mind when adjusting `RipgrepOptions` via Electron UI or remote calls.
- Any new search modes must still respect line length/total char limits to avoid overwhelming downstream consumers.
- When running locally, remember to install `ripgrep` so the tool can execute successfully.
