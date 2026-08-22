// server/tools/runtime/nodeToolRuntimeHost.ts
// Standalone-Node implementation of the tool sandbox host. Forks
// toolRuntimeUtility.mjs with child_process over the standard IPC channel.
// The child detects the missing Electron parentPort and falls back to
// process.send/process.on('message') — see toolRuntimeUtility.ts.

import { fork } from 'child_process'
import { ToolRuntimeSandboxHost, type SandboxProcessHandle } from './toolRuntimeSandbox.js'

function forkNodeChildProcess(entryPath: string): SandboxProcessHandle {
  const child = fork(entryPath, [], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })

  return {
    postMessage: message => {
      child.send(message as object)
    },
    onMessage: listener => {
      child.on('message', listener)
    },
    onExit: listener => {
      child.on('exit', code => listener(code))
    },
    onError: listener => {
      child.on('error', listener)
    },
    stdout: child.stdout,
    stderr: child.stderr,
    kill: () => {
      child.kill()
    },
  }
}

export class NodeToolRuntimeHost extends ToolRuntimeSandboxHost {
  constructor(options?: { entryPath?: string }) {
    super({ fork: forkNodeChildProcess, entryPath: options?.entryPath })
  }
}
