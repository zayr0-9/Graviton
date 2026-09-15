import path from 'path'
import { detectPathType, isWindows, resolveToWindowsPath, type WSLExecutionOptions } from '../utils/wslBridge.js'
import { runBoundedShell, type ShellRunOptions, type ShellRunResult } from './shellRunner.js'

export interface PowerShellOptions extends ShellRunOptions { description?: string }
export interface PowerShellResult extends ShellRunResult {}

export async function resolvePowerShellCwd(inputCwd?: string, execution: WSLExecutionOptions = {}): Promise<{ display: string; forSpawn: string }> {
  const input = inputCwd?.trim()
  const candidate = !input || input === '.' || input === '/' ? process.cwd() : input
  let cwd: string
  if (!isWindows()) cwd = path.resolve(candidate)
  else if (detectPathType(candidate) === 'linux') cwd = await resolveToWindowsPath(candidate, execution)
  else cwd = path.win32.resolve(candidate)
  return { display: cwd, forSpawn: cwd }
}

export function buildPowerShellCommand(command: string): { cmd: string; args: string[] } {
  return { cmd: isWindows() ? 'powershell.exe' : 'pwsh',
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command] }
}

export function runPowerShellCommand(command: string, options: PowerShellOptions = {}): Promise<PowerShellResult> {
  return runBoundedShell(async context => {
    const cwd = await resolvePowerShellCwd(options.cwd, context)
    return { ...buildPowerShellCommand(command), cwd: cwd.forSpawn, displayCwd: cwd.display }
  }, options, true)
}
