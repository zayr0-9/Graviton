---
paths:
  - "client/ygg-chat-r/server/tools/deleteFile.ts"
---

# Electron deleteFile Tool

This document explains how the `deleteFile.ts` helper inside `client/ygg-chat-r/electron/tools` works and how it can safely delete files from the Electron build environment.

## Purpose

The module exports two helpers:

- `deleteFile(filePath, operationMode?, cwd?)` – performs a straightforward deletion while enforcing workspace boundaries and plan-mode restrictions.
- `safeDeleteFile(filePath, allowedExtensions?, operationMode?, cwd?)` – wraps `deleteFile` with additional validation to avoid deleting sensitive files or files with unsupported extensions.

Both functions guard against executing destructive operations while the agent is in planning mode and limit file access to a configured workspace directory.

## deleteFile Function Workflow

1. **Operation Mode** – If `operationMode` is `'plan'`, the function throws an error immediately to prevent deletion during planning.
2. **Path Resolution**
   - Determines if the provided `filePath` is a WSL-style path via `isWSLPath`.
   - If targeting WSL and the path is relative, it prefixes the working `cwd` (if provided) to form an absolute POSIX path.
   - For native paths, it resolves the path against `cwd` or the current working directory using Node's `path.resolve`.
3. **Workspace Validation**
   - When `cwd` is supplied, the resolved path must reside within that workspace. WSL paths are compared with POSIX string checks, while native paths use `path.resolve` for canonical comparisons.
   - Any attempt to escape the workspace results in an explicit `Access denied` error.
4. **WSL Translation** – Paths identified as WSL are converted to Windows UNC paths via `resolveToWindowsPath` before touching the filesystem.
5. **Existence Check** – Before deletion, `fs.access` ensures the file exists, and a descriptive `File not found` error is thrown otherwise.
6. **Deletion** – Finally, `fs.unlink` removes the file and any errors are wrapped with `Failed to delete file` to provide context.

## safeDeleteFile Function Extensions

`safeDeleteFile` performs the same base workflow with the following guards:

- **Allowed Extensions** – When `allowedExtensions` is provided, the resolved file extension must match one of the allowed values (case-insensitive). Otherwise, an error explains which extensions are permissible.
- **Sensitive Path Protection** – Deletes are blocked when the normalized path contains high-risk targets such as `/etc/passwd`, `/proc`, `.env`, `.git`, or `node_modules`.

After validation passes, it calls `deleteFile` to reuse the core deletion and workspace-lockdown logic.

## Usage Notes

- Always supply the correct `cwd` to keep operations limited to the intended workspace. Without it, the helper defaults to `process.cwd()` for native paths, which might be more permissive than desired.
- Prefer `safeDeleteFile` when removing files that could be accidentally sensitive or when you want to enforce extension constraints.
- Handle exceptions thrown by these helpers to surface user-friendly warnings rather than raw stack traces; the errors already include contextual messages such as `Access denied` and `File not found`.

By reusing the same resolution and validation logic across both functions, the module keeps file deletion predictable, safe, and consistent across WSL and native execution contexts.