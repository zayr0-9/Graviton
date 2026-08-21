// electron/tools/runtime/UtilityToolRuntimeHost.ts
// Electron implementation of the tool sandbox host. This file is the only
// place the `utilityProcess` import is allowed to live — the request/response
// lifecycle is owned by the runtime-neutral ToolRuntimeSandboxHost, and the
// standalone server uses NodeToolRuntimeHost instead of this class.

import { utilityProcess } from 'electron'
import { ToolRuntimeSandboxHost, type SandboxProcessHandle } from './toolRuntimeSandbox.js'

function forkElectronUtilityProcess(entryPath: string): SandboxProcessHandle {
  const child = utilityProcess.fork(entryPath, [], {
    serviceName: 'ygg-tools-runtime',
    stdio: 'pipe',
  })

  return {
    postMessage: message => {
      child.postMessage(message)
    },
    onMessage: listener => {
      child.on('message', listener)
    },
    onExit: listener => {
      child.on('exit', (code: number) => listener(code))
    },
    onError: listener => {
      // Electron types UtilityProcess events as 'spawn' | 'exit' | 'message'
      // only, so 'error' is not in the overload set. Registering it is
      // harmless and preserves existing behaviour if Electron ever emits it.
      ;(child as unknown as NodeJS.EventEmitter).on('error', listener)
    },
    stdout: child.stdout,
    stderr: child.stderr,
    kill: () => {
      child.kill()
    },
  }
}

export class UtilityToolRuntimeHost extends ToolRuntimeSandboxHost {
  constructor(options?: { entryPath?: string }) {
    super({ fork: forkElectronUtilityProcess, entryPath: options?.entryPath })
  }
}
