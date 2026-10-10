---
paths:
  - "client/ygg-chat-r/server/tools/editFile.ts"
  - "client/ygg-chat-r/server/tools/editFileIO.ts"
---

# `editFile.ts` Tool Documentation

Located at `client/ygg-chat-r/server/tools/editFile.ts`, this helper is a lightweight, search-and-replace-based file editing toolkit used by the Electron automation layer. It can replace, replace the first occurrence, or append content with extra safety checks and a layered matching strategy to keep edits precise even when the source text changes slightly.

## Key Responsibilities

- Resolve cross-platform paths (WSL ↔ Windows) and enforce `cwd`-based workspace boundaries.
- Support edit operations (`replace`, `replace_first`, `append`) through a single `editFile()` entrypoint.
- Perform layered matching (exact → normalized → fuzzy) to make edits resilient.
- Preserve indentation, interpret escape sequences, and optionally validate the file hasn't drifted since it was read.
- Optionally create timestamped backups before overwriting content.

## Entry-point and Operations

### `editFile(filePath, operation, options)`

Public `edit_file` requires `path`, `operation`, `approxStartLine`, and
`approxEndLine` on every call, including append. Replace operations also need
`searchPattern`/`replacement`; append needs `content`. Direct helper callers may
omit line hints; they guide the preferred `replace_first` search window.

- Normalizes the requested path, enforces workspace (`cwd`) restrictions, and refuses edits when `operationMode` is `'plan'`.
- Delegates to one of three helpers depending on `operation`:
  - `replace`: Replaces every exact match globally, or one matched span for non-exact strategies (via `editFileSearchReplace`).
  - `replace_first`: Replaces just the first match (`editFileSearchReplaceFirst`).
  - `append`: Appends `content` to the end (`appendToFile`).

Each helper uses `editFileIO.ts` for canonical path resolution, a per-target in-process queue, a complete encoding-aware read, raw-byte backups, and descriptor-based writes. Files and results are limited to 32 MiB, independently of the public `read_file` output limit. The common exact path does not run fuzzy matching or hash the file.

## Editing Behavior

### Path Resolution & Workspace Bounding
- Uses `isWSLPath`, `resolveToWindowsPath`, and `toWslPath` from `../utils/wslBridge.js` to safely interact with WSL-hosted files.
- For non-WSL paths, it normalizes and resolves against `options.cwd` or `process.cwd()`.
- If `options.cwd` is set, both lexical and canonical targets must remain inside the workspace, subject to managed-tool exceptions. New append targets validate the canonical parent; dangling symlinks are rejected.
- Relative paths under a WSL cwd use WSL resolution for both reads and writes.

### Validation
- `validateFileContent()` enforces file identity / modification-time checks from `expectedMetadata` when `validateContent` is enabled.
- `expectedHash` is accepted for compatibility and surfaced in validation details when available, but a hash mismatch no longer blocks the edit.
- Validation defaults to enabled for all operations, including append. Missing files with supplied expectations fail instead of being recreated.
- `multi_edit` validates the initial metadata and tracks the versions produced by successful items; later items reject intervening changes. Input-to-canonical-path mappings are pinned for the batch.
- Before writing, file identity, size, mtime and ctime are rechecked. Internal calls in the same process serialize by canonical target. This is not cross-process locking or a sandbox against adversarial ancestor-directory races. Writes preserve the inode and are not crash-atomic.
- If metadata validation fails, editing is aborted and a descriptive error is returned.

### Backup
- Passing `options.createBackup` writes original bytes to an exclusively created `<file>.backup.<timestamp>.<uuid>` before replacing/appending.
- Both registries invoke managed stream-undo backup hooks inside each successful match's pre-write stage, rather than preflighting every batch path. Item failures therefore obey `stopOnError`.
- Backups use UNC paths when running from Windows to ensure compatibility.

### Search & Replace Logic
- Search escapes (`\n`, `\t`, etc.) are interpreted by default; replacement text is literal by default. Internal callers may override `interpretSearchEscapes` and `interpretReplacementEscapes`; deprecated `interpretEscapeSequences` supplies both defaults when the specific flags are absent.
- `preserveIndentation` reapplies base indentation only for whitespace/fuzzy matches, preserving dedents. Line-ending-only matches leave replacement indentation unchanged.
- A hinted local exact match wins; otherwise a full-file exact match wins before local normalized matching. Fuzzy matching never runs in the local window first.
- `replace` performs global replacement only when the winning strategy is `exact`.
- If the winning strategy is `line_ending_normalized`, `whitespace_normalized`, or `fuzzy`, `replace` applies a single replacement at the matched span returned by the layered matcher.

### Match Strategies
Implementing several fallbacks makes searches more resilient:
1. **`exact`** – plain string search on the interpreted pattern.
2. **`line_ending_normalized`** – flattens `\r\n` to `\n` before matching.
3. **`whitespace_normalized`** – collapses whitespace/tabs per line and trims before comparing.
4. **`fuzzy`** – disabled by default. Internal callers can opt in with `enableFuzzyMatching`; two-row Levenshtein uses a 2-million-cell total budget and a 4096-character normalized-pattern limit. Budget exhaustion and tied best candidates fail closed. The agent schema uses deterministic matching by default.

`findMatchWithStrategies()` reports which strategy succeeded as part of the result, including similarity for fuzzy matches.

### Append Operation
- Reads the current file (if it exists), validates metadata, and supports optional backups.
- Writes at the verified end offset through the same descriptor and reports success with `replacements: 1` for consistency. Missing targets use exclusive creation.

## Result Shape (`EditFileResult`)
A successful call includes:
- `success`: `true`
- `sizeBytes`: byte length of the file after modification
- `replacements`: number of replacements performed (or `1` for append)
- `message`: descriptive status string
- `matchStrategy` / `attemptedStrategies`: useful for debugging layered matching
- `validation`: details when validation ran
- `backup`: native backup path (UNC for Windows-hosted WSL targets)

Failure responses explain the issue (e.g., not in workspace, pattern not found, validation failure).

## Usage Notes
- Prefer `editFile()` over manual `fs` writes to leverage workspace safety and matching resilience.
- Prefer `expectedMetadata` when chaining edits to guard against concurrent modifications. `expectedHash` is optional and advisory.
- Use `operationMode: 'plan'` when you need to describe changes without mutating files.
- Indentation preservation works best when the replacement text mirrors the original structure (same number of lines, reasonable indentation cues).

## Dependencies
- Uses the `FileMetadata` contract from `./readFile.js`, but complete edit reads live in `./editFileIO.js` and do not bypass public read limits.
- Supports lossless UTF-8, UTF-16LE, Latin-1 and ASCII decoding; unsupported encodings or lossy decoding fail without editing.
- Imports WSL bridge helpers from `../utils/wslBridge.js` for cross-platform path interoperability.

Keep this document updated if new matching strategies, validation checks, or options are introduced in `editFile.ts`.
