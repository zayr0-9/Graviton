# `editFile.ts` Tool Documentation

Located at `client/ygg-chat-r/electron/tools/editFile.ts`, this helper is a lightweight, search-and-replace-based file editing toolkit used by the Electron automation layer. It can replace, replace the first occurrence, or append content with extra safety checks and a layered matching strategy to keep edits precise even when the source text changes slightly.

## Key Responsibilities

- Resolve cross-platform paths (WSL ↔ Windows) and enforce `cwd`-based workspace boundaries.
- Support edit operations (`replace`, `replace_first`, `append`) through a single `editFile()` entrypoint.
- Perform layered matching (exact → normalized → fuzzy) to make edits resilient.
- Preserve indentation, interpret escape sequences, and optionally validate the file hasn't drifted since it was read.
- Optionally create timestamped backups before overwriting content.

## Entry-point and Operations

### `editFile(filePath, operation, options)`
- Normalizes the requested path, enforces workspace (`cwd`) restrictions, and refuses edits when `operationMode` is `'plan'`.
- Delegates to one of three helpers depending on `operation`:
  - `replace`: Replaces every exact match globally, or one matched span for non-exact strategies (via `editFileSearchReplace`).
  - `replace_first`: Replaces just the first match (`editFileSearchReplaceFirst`).
  - `append`: Appends `content` to the end (`appendToFile`).

Each helper performs its own path handling, optional validation, backup creation, and writes the modified content back to disk.

## Editing Behavior

### Path Resolution & Workspace Bounding
- Uses `isWSLPath`, `resolveToWindowsPath`, and `toWslPath` from `../utils/wslBridge.js` to safely interact with WSL-hosted files.
- For non-WSL paths, it normalizes and resolves against `options.cwd` or `process.cwd()`.
- If `options.cwd` is set, it verifies that the target file lives inside the workspace and returns an access-denied result otherwise.

### Validation
- `validateFileContent()` enforces file identity / modification-time checks from `expectedMetadata` when `validateContent` is enabled.
- `expectedHash` is accepted for compatibility and surfaced in validation details when available, but a hash mismatch no longer blocks the edit.
- If metadata validation fails, editing is aborted and a descriptive error is returned.

### Backup
- Passing `options.createBackup` writes the original content to `<file>.backup.<iso-timestamp>` before replacing/appending.
- Backups use UNC paths when running from Windows to ensure compatibility.

### Search & Replace Logic
- Escape sequences (`\n`, `\t`, etc.) are interpreted in both the search pattern and replacement text when `interpretEscapeSequences` is `true`.
- `preserveIndentation` can reapply the indentation style of the replaced block if a fuzzy or normalized match succeeds.
- `replace` performs global replacement only when the winning strategy is `exact`.
- If the winning strategy is `line_ending_normalized`, `whitespace_normalized`, or `fuzzy`, `replace` applies a single replacement at the matched span returned by the layered matcher.

### Match Strategies
Implementing several fallbacks makes searches more resilient:
1. **`exact`** – plain string search on the interpreted pattern.
2. **`line_ending_normalized`** – flattens `\r\n` to `\n` before matching.
3. **`whitespace_normalized`** – collapses whitespace/tabs per line and trims before comparing.
4. **`fuzzy`** – permitted by default via Levenshtein distance; can be disabled via `enableFuzzyMatching`.

`findMatchWithStrategies()` reports which strategy succeeded as part of the result, including similarity for fuzzy matches.

### Append Operation
- Reads the current file (if it exists) to support optional backups but does not enforce validation.
- Uses `fs.promises.appendFile()` to add the requested content and reports success with `replacements: 1` for consistency.

## Result Shape (`EditFileResult`)
A successful call includes:
- `success`: `true`
- `sizeBytes`: byte length of the file after modification
- `replacements`: number of replacements performed (or `1` for append)
- `message`: descriptive status string
- `matchStrategy` / `attemptedStrategies`: useful for debugging layered matching
- `validation`: details when validation ran
- `backup`: WSL path to the backup if created

Failure responses explain the issue (e.g., not in workspace, pattern not found, validation failure).

## Usage Notes
- Prefer `editFile()` over manual `fs` writes to leverage workspace safety and matching resilience.
- Prefer `expectedMetadata` when chaining edits to guard against concurrent modifications. `expectedHash` is optional and advisory.
- Use `operationMode: 'plan'` when you need to describe changes without mutating files.
- Indentation preservation works best when the replacement text mirrors the original structure (same number of lines, reasonable indentation cues).

## Dependencies
- Relies on `readTextFile`/`FileMetadata` from `./readFile.js` to read contents with metadata.
- Imports WSL bridge helpers from `../utils/wslBridge.js` for cross-platform path interoperability.

Keep this document updated if new matching strategies, validation checks, or options are introduced in `editFile.ts`.
