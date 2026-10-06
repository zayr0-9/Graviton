---
paths:
  - "client/ygg-chat-r/server/tools/readFiles.ts"
  - "client/ygg-chat-r/server/tools/readFile.ts"
---

# readFiles Tool

`client/ygg-chat-r/server/tools/readFiles.ts` implements `read_files` in both the server registry and utility runtime. It reuses `readFile.ts` and returns one combined text representation with compact truncation/count metadata.

## How it works

1. **Input validation** – `readMultipleTextFiles` first ensures it received a non-empty array of paths.
2. **Working directory** – takes an optional `cwd` option but falls back to `process.cwd()` when resolving relative paths. This keeps every call scoped to the desired workspace.
3. **Base directory for headers** – the `baseDir` option (defaulting to `cwd`) determines how each file path is turned into the relative header that the tool returns. All header paths use POSIX-style slashes (`/`) for consistency.
4. **Aggregate budget** – files are read in input order with a shared UTF-8 byte budget. Relative-path headers, separators, file content and error placeholders count toward `maxBytes` (default 204800, maximum 5242880). The tool also caps line/range output and does not split UTF-8 characters. Reads stop at the first truncated file or when the next header cannot fit; later files are not read.
5. **WSL/Windows normalization** – before calculating relative paths, the tool resolves WSL or Windows paths to a Linux-style absolute path (using `resolveToWindowsPath` and `toWslPath`). This step ensures the header math works whether the agent is running under WSL or native Windows.
6. **Result shaping** – each returned record includes:
   - `filename`: relative path from `baseDir` with forward slashes.
   - `content`: text returned by `readTextFile` (possibly truncated/ranged).
   - `totalLines`: reported line count (computed if missing).

If any file fails to read, the tool catches the error and returns a placeholder record with a message in `content` and `totalLines` set to `0`. This keeps the caller aware of the failure without throwing the entire batch.

## Options summary

- `inputPaths: string[]` – required list of file paths to read.
- `baseDir?: string` – determines how the `filename` header is computed. Defaults to the resolved `cwd`.
- `maxBytes?: number` – total byte limit on the combined output text, including headers and separators. Small response metadata is additional.
- `startLine?: number` / `endLine?: number` – forwarded range to limit the read to a portion of each file.
- `cwd?: string` – workspace root for resolving and validating relative paths (default: current working directory).

All other read options (such as `ranges`) are handled through `readTextFile` when the `read_files` action is invoked.

## How it is used

The server and utility registries expose this tool with the resolved workspace root as `cwd`. Both use the same formatter:

```ts
const filesRes = await readMultipleTextFiles(paths, {
  baseDir,
  maxBytes,
  startLine,
  endLine,
  cwd: rootPath,
})

return formatReadFilesResult(filesRes, paths.length)
```

The response includes `content`, `truncated`, `returnedCount`, `omittedCount`, and `nextFileIndex`. `nextFileIndex` identifies the partially returned file, or the first unread file when no file was partially returned. Use a focused `read_file` with line/range arguments to continue a partial file. Content is not duplicated in a `text` field or `files` array.

## Related helpers

- `readTextFile` (`readFile.ts`) handles the heavy lifting for single-file reads, including binary detection, hashing, and range slicing.
- `wslBridge.ts` helpers (`resolveToWindowsPath`, `isWSLPath`, and `toWslPath`) ensure the tool works correctly whether it runs on Windows, WSL, or POSIX environments.
