import path from 'path'
import { randomUUID } from 'crypto'
import { detectPathType, getWSLCommandArgs, isWindows } from '../utils/wslBridge.js'
import { buildNativeShellCommand } from './nativeShell.js'
import { runBoundedShell, type ShellRunOptions, type ShellRunResult } from './shellRunner.js'

export interface BashOptions extends ShellRunOptions { description?: string }
export interface BashResult extends ShellRunResult {}

const EXIT_1_NO_MATCH_COMMANDS = ['grep', 'egrep', 'fgrep', 'diff', 'cmp', 'awk']
function getDefaultSuccessCodes(command: string): number[] {
  const first = command.trim().split(/\s+/)[0].split('/').pop() || ''
  return EXIT_1_NO_MATCH_COMMANDS.includes(first) ? [0, 1] : [0]
}

export function runBashCommand(command: string, options: BashOptions = {}): Promise<BashResult> {
  return runBoundedShell(async context => {
    const input = options.cwd?.trim()
    const candidate = !input || input === '.' || input === '/' ? process.cwd() : input
    if (!isWindows()) {
      const cwd = path.resolve(candidate)
      const native = buildNativeShellCommand(command)
      // Preserve login/interactive PATH initialization, but keep descendants in our group.
      if (['bash', 'zsh', 'sh', 'ksh'].includes(path.basename(native.cmd))) {
        native.args = ['-lic', `set +m; ${command}`]
      }
      return { ...native, cwd, displayCwd: cwd }
    }
    if (detectPathType(candidate) === 'linux') {
      const marker = `__YGG_GROUP_${randomUUID().replace(/-/g, '')}__`
      // setsid owns only this invocation; no distro-wide termination is used.
      const [cmd, args] = await getWSLCommandArgs('setsid', ['bash', '-c',
        `printf '${marker}%s\\n' "$$" >&2; exec bash -lc "$1"`, 'ygg-shell', `set +m; ${command}`], candidate, context)
      return { cmd, args, displayCwd: candidate, wsl: { distro: args[1], marker } }
    }
    const cwd = path.win32.resolve(candidate)
    return { cmd: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', command], cwd, displayCwd: cwd }
  }, { ...options, successCodes: options.successCodes ?? getDefaultSuccessCodes(command) })
}
