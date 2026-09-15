---
paths:
  - "client/ygg-chat-r/server/tools/directory.ts"
---

# Directory Tool (`directory.ts`)

This helper lives in `client/ygg-chat-r/electron/tools/directory.ts` and exports `extractDirectoryStructure`, a utility that safely walks a directory tree and returns a text-based tree listing. It is used by the Electron surface to answer requests for the contents of a folder while enforcing workspace boundaries and ignoring irrelevant files.

## Main Responsibilities

1. **Workspace detection**: it lazily resolves the workspace root by checking, in order:
   - `WORKSPACE_ROOT` environment variable
   - the repository root (`client/ygg-chat-r`) relative to the tool file
   - the current working directory
   The chosen path is verified as a directory and normalized once for subsequent checks.
2. **Path sanitization and security**:
   - The caller-supplied path is trimmed and defaulted to `.` (which maps to the workspace root).
   - Access to filesystem roots (e.g., `/` or `C:\`) is explicitly denied.
   - Non-absolute paths are resolved relative to the workspace root, making it impossible to escape via `../`.
   - On Windows, Linux-style paths are converted to UNC paths via `resolveToWindowsPath` to keep Node.js API compatibility.
   - Final paths are validated with `ensurePathWithinWorkspace`, which rejects any directory that is outside the normalized workspace root.

## Usage Options (`DirectoryOptions`)

- `maxDepth?: number`
  - Limits how many levels deep the tool descends, defaulting to unlimited when undefined.
  - Values are clamped between 1 and 5 (non-integers are floored).
- `includeHidden?: boolean` (default: `false`)
  - When false, entries beginning with `.` are skipped.
- `includeSizes?: boolean` (default: `false`)
  - When true, file entries append a human-readable size like `1.2MB`.

## Traversal Logic

- Before walking, the tool ensures the resolved directory exists and is a directory.
- Ignores are collected from three layers:
  1. **Built-in defaults**: version-control dirs, dependency folders (`node_modules`, `vendor`, ...), build outputs (`dist`, `build`, ...), editor metadata (`.vscode`, `.idea`), OS artifacts, and temp/log folders.
  2. **Wildcard patterns**: `*.swp`, `*.swo`, `*~`, `*.log`, `*.tmp`.
  3. **`.gitignore` entries**: the tool reads `.gitignore` from the root directory and adds each non-comment, non-negated pattern to the ignore set. Directory patterns ending with `/` are treated specially for directory-only matches.
- Each directory is walked with `walkDirectory`, which:
  - Respects the `maxDepth` limit and permission errors (adding `[Permission Denied]` to the output when it cannot read a folder).
  - Filters entries to skip hidden or ignored files.
  - Optionally collects `fs.Stats` for sizes if `includeSizes` is enabled.
  - Sorts entries with directories first and then alphabetically (case-insensitive).
  - Recursively recurses into directories with an increasing indentation prefix (`  ` per depth level).
- File size formatting is handled by `getFileSizeStr`, which chooses `B`, `KB`, `MB`, `GB`, or `TB` with one decimal place.

## Errors and Messages

- If the initial path is inaccessible, not a directory, or outside the workspace, `extractDirectoryStructure` rejects with an error describing why.
- Permission errors while walking a subtree append `[Permission Denied]` to the result but do not fail the entire operation.
- When entries cannot be listed for other reasons, they emit `[Error: ...]` to provide context.

## Security Considerations

- Path normalization ensures that even symbolic references or UNC paths are checked against the workspace root.
- Root-level access is blocked and any attempt to specify `.`/`./` resolves to the workspace root itself.
- Hidden files are opt-in only, limiting accidental exposure of dotfiles.

## Example

Although `directory.ts` is not exposed as a CLI, the exported `extractDirectoryStructure` can be used like this (pseudo-code within the Electron backend):

```ts
const tree = await extractDirectoryStructure('client', { maxDepth: 3, includeSizes: true })
console.log(tree)
```

The returned string looks like:

```
client/
  docs/
    README.md (12.5KB)
  src/
    index.ts (8.3KB)
```

This string is what the frontend displays when a user requests the contents of a directory.
