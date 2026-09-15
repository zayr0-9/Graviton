---
paths:
  - "client/ygg-chat-r/server/tools/readFiles.ts"
  - "client/ygg-chat-r/server/tools/readFile.ts"
---

# readFiles Tool

`client/ygg-chat-r/electron/tools/readFiles.ts` provides the implementation behind the `read_files` IPC action exposed by the local Electron server. It reuses the single-file reader (`readFile.ts`) to return structured metadata for multiple files in one call.

## How it works

1. **Input validation** – `readMultipleTextFiles` first ensures it received a non-empty array of paths.
2. **Working directory** – takes an optional `cwd` option but falls back to `process.cwd()` when resolving relative paths. This keeps every call scoped to the desired workspace.
3. **Base directory for headers** – the `baseDir` option (defaulting to `cwd`) determines how each file path is turned into the relative header that the tool returns. All header paths use POSIX-style slashes (`/`) for consistency.
4. **Per-file read** – for each path, `readTextFile` is invoked with the same `maxBytes`, `startLine`, `endLine`, and workspace `cwd`. This means any line-ranged or truncated read is handled inline by the core reader.
5. **WSL/Windows normalization** – before calculating relative paths, the tool resolves WSL or Windows paths to a Linux-style absolute path (using `resolveToWindowsPath` and `toWslPath`). This step ensures the header math works whether the agent is running under WSL or native Windows.
6. **Result shaping** – each returned record includes:
   - `filename`: relative path from `baseDir` with forward slashes.
   - `content`: text returned by `readTextFile` (possibly truncated/ranged).
   - `totalLines`: reported line count (computed if missing).

If any file fails to read, the tool catches the error and returns a placeholder record with a message in `content` and `totalLines` set to `0`. This keeps the caller aware of the failure without throwing the entire batch.

## Options summary

- `inputPaths: string[]` – required list of file paths to read.
- `baseDir?: string` – determines how the `filename` header is computed. Defaults to the resolved `cwd`.
- `maxBytes?: number` – forwarded to `readTextFile` to limit bytes read for each file.
- `startLine?: number` / `endLine?: number` – forwarded range to limit the read to a portion of each file.
- `cwd?: string` – workspace root for resolving and validating relative paths (default: current working directory).

All other read options (such as `ranges`) are handled through `readTextFile` when the `read_files` action is invoked.

## How it is used

The Electron local server exposes this tool through the `read_files` command, passing the workspace root as `cwd`. A typical usage inside `client/ygg-chat-r/electron/localServer.ts` looks like this:

```ts
const filesRes = await readMultipleTextFiles(paths, {
  baseDir,
  maxBytes,
  startLine,
  endLine,
  cwd: rootPath,
})

return {
  success: true,
  files: filesRes,
}
```

The response is then marshaled back to the UI, where each entry includes `filename`, `content`, and `totalLines` for rendering or further processing.

## Related helpers

- `readTextFile` (`readFile.ts`) handles the heavy lifting for single-file reads, including binary detection, hashing, and range slicing.
- `wslBridge.ts` helpers (`resolveToWindowsPath`, `isWSLPath`, and `toWslPath`) ensure the tool works correctly whether it runs on Windows, WSL, or POSIX environments.
