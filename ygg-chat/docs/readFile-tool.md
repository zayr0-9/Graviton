---
paths:
  - "client/ygg-chat-r/server/tools/readFile.ts"
  - "client/ygg-chat-r/server/tools/readFiles.ts"
  - "client/ygg-chat-r/server/tools/__tests__/readFile.test.ts"
---

# read_file and read_file_continuation

Both tools use `client/ygg-chat-r/server/tools/readFile.ts`; both runtime registries forward trusted workspace, cancellation, and deadline context. Agent-visible parameters live in `shared/builtinToolDefinitions.ts`.

## Parameters

- `path`: required file path. Relative paths resolve against `cwd`, which defaults to the runtime workspace (or process cwd without a workspace).
- `cwd`: resolution base, not a narrower workspace boundary. The runtime validates it against workspace/managed directories.
- `maxBytes`: integer 1–5242880, default 204800. Bounds UTF-8 **returned content**, including range separators. Metadata, binary probing, lookahead and scanning to reach a requested line are additional.
- `startLine` / `endLine`: inclusive, positive safe integers. Start defaults to 1; omitted end reads toward EOF within the budget.
- `ranges`: 1–32 inclusive ranges, each with end >= start. Overrides single-range arguments. Supplied order and overlaps are preserved. All ranges share one budget; sections are separated by two LF characters.
- `includeHash`: default false. `contentHash` hashes the returned text; `fileHash` hashes raw file bytes and is omitted unless the complete file was scanned. These hashes are informational; edit_file does not reject hash mismatches.
- Continuation takes `afterLine` (0 or a positive safe integer) and `numLines` (positive safe integer) instead of line/range options. Their sum must be safe.

Internal `workspaceRoot`, `signal` and `deadlineMs` are runtime-only, not model-controlled parameters.

## Results and pagination

File properties are in `metadata`. Line bounds, `ranges`, `totalLines`, `nextLine`, `partialLastLine`, and `nextRangeIndex` are top-level fields. `totalLines` is unknown until EOF; empty files and the empty line following a trailing newline follow String.split line-count semantics.

Full reads preserve text including its trailing terminator. Line selections preserve original internal LF/CRLF endings and omit the terminator after the final selected line. Disjoint-range separators are formatting, not source text.

`truncated` means the byte budget prevented returning the complete requested selection. For a line read, resume with `startLine: nextLine` or continuation `afterLine: nextLine - 1`. If `partialLastLine` is true, that line must be reread with a larger budget; advancing past it would skip content. There is no byte-offset continuation for a single line larger than the maximum budget. For multiple ranges, resume from the zero-based `nextRangeIndex`, adjusting that range's start to `nextLine`.

## Safety and limitations

- Lexical and canonical paths must remain inside the workspace or permitted managed roots. Ordinary symlinks escaping these roots are rejected; internal symlinks are supported. Managed roots are canonicalized too.
- Reads use one descriptor, bounded buffers, initialized-byte slices, incremental line scanning, and UTF-8-safe truncation. Non-regular files and likely binary input are rejected.
- Cancellation/deadlines are checked between asynchronous filesystem operations and read chunks. An already-blocked OS filesystem operation cannot be forcibly interrupted by these checks.
- Canonical-path checks and O_NOFOLLOW where available reduce symlink races but are not a hostile-filesystem sandbox: concurrent ancestor replacement remains a platform-level TOCTOU limitation.
- Ranges are scanned in supplied order; each starts scanning at the beginning of the file. This bounds memory and preserves arbitrary order, but many distant ranges can reread the same prefix (capped at 32 ranges).
- Encoding is UTF-8 only; invalid input bytes use Node's replacement-character decoding. Binary detection is a prefix heuristic, not a format validator.

## Validation

Use the tools Vitest config for `readFile.test.ts`, `readFiles.test.ts`, and `runtime/__tests__/utilityCancellation.test.ts`. Coverage includes budgets, UTF-8, CRLF chunk/budget boundaries, symlink scope, managed paths, hashes, short reads, cancellation, schema limits, and runtime context forwarding.
