import path from 'path'
import { describe, expect, it } from 'vitest'
import { buildPowerShellCommand, resolvePowerShellCwd, runPowerShellCommand } from '../powershell.js'

describe('PowerShell tool command construction', () => {
  it('uses powershell.exe on Windows and pwsh elsewhere', () => {
    const built = buildPowerShellCommand('Write-Output "hello"')

    expect(built.cmd).toBe(process.platform === 'win32' ? 'powershell.exe' : 'pwsh')
    expect(built.args).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      'Write-Output "hello"',
    ])
  })
})

describe('PowerShell tool cwd resolution', () => {
  it('resolves relative cwd to an absolute native path', async () => {
    const resolved = await resolvePowerShellCwd('.')

    expect(path.isAbsolute(resolved.display)).toBe(true)
    expect(path.isAbsolute(resolved.forSpawn)).toBe(true)
  })
})

describe('runPowerShellCommand', () => {
  it.skipIf(process.platform !== 'win32')('runs a Windows PowerShell command', async () => {
    const result = await runPowerShellCommand('$PSVersionTable.PSEdition; Write-Output "powershell-ok"', {
      description: 'Verify native Windows PowerShell command execution',
      cwd: process.cwd(),
      timeoutMs: 10_000,
      maxOutputChars: 10_000,
    })

    expect(result.success).toBe(true)
    expect(result.stdout).toContain('powershell-ok')
    expect(result.stderr).toBe('')
  })

  it.skipIf(process.platform === 'win32')('uses pwsh on non-Windows when available', async () => {
    const result = await runPowerShellCommand('Write-Output "powershell-ok"', {
      description: 'Verify PowerShell Core command execution',
      cwd: process.cwd(),
      timeoutMs: 10_000,
      maxOutputChars: 10_000,
    })

    // This test is only meaningful on systems with pwsh installed; otherwise the
    // tool should surface a clear spawn error rather than throwing.
    if (!result.success && result.error?.includes('ENOENT')) {
      expect(result.error).toContain('ENOENT')
      return
    }

    expect(result.success).toBe(true)
    expect(result.stdout).toContain('powershell-ok')
  })
})
