import { describe, expect, it } from 'vitest'
import { buildNativeShellCommand, getNativeShellPath, resolveNativeShell } from '../nativeShell.js'

describe('native POSIX shell resolution', () => {
  it.skipIf(process.platform === 'win32')('uses the configured user shell', () => {
    const shell = process.env.SHELL || '/bin/bash'

    expect(resolveNativeShell({ SHELL: shell })).toBe(shell)
    expect(buildNativeShellCommand('printf ok', { SHELL: shell })).toEqual({
      cmd: shell,
      args: ['-lic', 'printf ok'],
    })
  })

  it.skipIf(process.platform === 'win32')('falls back to /bin/bash when SHELL is unavailable', () => {
    expect(resolveNativeShell({}, null)).toBe('/bin/bash')
    expect(resolveNativeShell({ SHELL: '/not/a/real/shell' }, null)).toBe('/bin/bash')
  })

  it.skipIf(process.platform === 'win32')('loads PATH from the user terminal shell', async () => {
    const shellPath = await getNativeShellPath()

    expect(shellPath).toBeTruthy()
    expect(shellPath?.split(':')).toContain('/usr/bin')
  })
})
