---
paths:
  - "client/ygg-chat-r/server/tools/createFile.ts"
---

# `client/ygg-chat-r/server/tools/createFile.ts`

This utility implements `createTextFile`, a TypeScript helper used by the Yggdrasil Electron tooling layer for safely creating text files (e.g., for scaffolding, automation helpers, or CLI commands).

## Key responsibilities

1. **Path resolution**
   - Resolves relative paths against `cwd`, or `process.cwd()` when omitted. There is no `directory` option.
   - Handles WSL-style POSIX paths (`/home/...`, `/mnt/...`) when invoked from Windows by converting them back to UNC paths (`\\wsl$\...`) before performing any filesystem operations.
   - Checks lexical containment against `cwd` before Windows conversion, with managed-tool-path exceptions. Canonicalizes existing ancestors and target paths before creating directories and rechecks before opening. Rejects symlink escapes and dangling symlinks. Writes use the canonical path plus no-follow flags where supported. This is not an OS-level sandbox against a hostile process concurrently replacing parent directories.

2. **File creation semantics**
   - Creates parent directories automatically by default (`createParentDirs = true`), but can require existing directories when the option is set to `false`.
   - Checks `overwrite`: an existing file is rejected when false and replaced when true. Default writes use exclusive creation, so concurrent creators cannot clobber one another. Explicit overwrite validates a regular file descriptor before truncating it.
   - Supports a `plan` operation mode, which blocks all writes and returns a message describing that creation is disallowed while planning.

3. **Platform-specific behavior**
   - Uses utility helpers from `server/utils/wslBridge.ts` (`isWSLPath`, `resolveToWindowsPath`) to detect WSL contexts and translate Linux-style paths into Windows UNC equivalents.
   - Optionally marks files as executable (`chmod 0o755`) when requested, respecting Windows/WSL distinctions by skipping chmod on native Windows but still attempting it when operating on WSL paths.

4. **Output contract**
   - Always returns a `CreateFileResult` describing:
     - `success`: whether the overall operation succeeded,
     - `created`: whether a new file was written,
     - `sizeBytes`: the resulting file size (zero when no file was written),
     - `message`: a human-readable explanation for logging or reporting.
   - Catches and synthesizes filesystem errors so callers can handle failures without throwing.

## API signature

```ts
export async function createTextFile(
  filePath: string,
  content: string = '',
  options: CreateFileOptions = {}
): Promise<CreateFileResult>
```

### Important options

- `createParentDirs?: boolean` – When `true` (default), missing parents are created recursively.
- `overwrite?: boolean` – When `false` (default), existing files are not clobbered.
- `executable?: boolean` – Requests that `chmod 0o755` be applied (skipped on vanilla Windows unless WSL path).
- `operationMode?: 'plan' | 'execute'` – `'plan'` mode blocks file creation altogether.
- `cwd?: string` – Relative-path base and lexical scope boundary, subject to managed-tool exceptions. Registries validate supplied `cwd` against the trusted workspace.

## Integration notes

Other electron tooling scripts (e.g., `editFile.ts`, `todoMd.ts`, `directory.ts`) can depend on `createTextFile` to ensure consistent path sanitization, workspace enforcement, and error-handling when writing artifacts. This centralization avoids repeating WSL path translations or permission tweaks across helpers.
