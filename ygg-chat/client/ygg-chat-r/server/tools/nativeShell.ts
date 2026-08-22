import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { userInfo } from 'os'

const FALLBACK_POSIX_SHELL = '/bin/bash'
const PATH_MARKER = '__YGG_SHELL_PATH__='

let nativeShellPathPromise: Promise<string | null> | null = null

/** Resolve the user's configured POSIX shell, falling back to the app's known bash. */
export function resolveNativeShell(
  env: NodeJS.ProcessEnv = process.env,
  accountShell: string | null | undefined = userInfo().shell
): string {
  const shellCandidates = [env.SHELL, accountShell]
    .map(shell => shell?.trim())
    .filter((shell): shell is string => Boolean(shell))

  return shellCandidates.find(shell => existsSync(shell)) || FALLBACK_POSIX_SHELL
}

/**
 * Match a terminal session closely enough to load shell-managed PATH entries
 * (Homebrew, nvm, asdf, etc.) while still executing a bounded command.
 */
export function buildNativeShellCommand(command: string, env: NodeJS.ProcessEnv = process.env) {
  return {
    cmd: resolveNativeShell(env),
    args: ['-lic', command],
  }
}

/** Read PATH from the user's terminal shell without replacing the process environment. */
export async function getNativeShellPath(): Promise<string | null> {
  if (process.platform === 'win32') {
    return null
  }

  if (!nativeShellPathPromise) {
    nativeShellPathPromise = new Promise(resolve => {
      const { cmd, args } = buildNativeShellCommand(`printf '\n${PATH_MARKER}%s\n' "$PATH"`)
      const child = spawn(cmd, args, {
        env: process.env,
        stdio: ['ignore', 'pipe', 'ignore'],
      })

      let stdout = ''
      let settled = false
      const timeout = setTimeout(() => {
        child.kill('SIGTERM')
        finish(null)
      }, 5_000)
      const finish = (value: string | null) => {
        if (!settled) {
          settled = true
          clearTimeout(timeout)
          resolve(value)
        }
      }

      child.stdout.on('data', data => {
        stdout += data.toString('utf8')
      })
      child.on('error', () => finish(null))
      child.on('close', code => {
        if (code !== 0) {
          finish(null)
          return
        }

        const markerIndex = stdout.lastIndexOf(PATH_MARKER)
        const shellPath = markerIndex >= 0
          ? stdout.slice(markerIndex + PATH_MARKER.length).split(/\r?\n/, 1)[0]?.trim()
          : ''
        finish(shellPath || null)
      })
    })
  }

  return nativeShellPathPromise
}
