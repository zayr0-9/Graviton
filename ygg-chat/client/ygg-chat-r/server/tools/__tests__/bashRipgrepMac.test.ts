import { describe, expect, it } from 'vitest'
import { runBashCommand } from '../bash.js'
import { ripgrepSearch } from '../ripgrep.js'

const isMac = process.platform === 'darwin'

describe.skipIf(!isMac)('macOS terminal environment integration', () => {
  it('runs commands through the configured user shell and finds Node', async () => {
    const result = await runBashCommand('printf "%s\\n" "$SHELL"; command -v node; node --version', {
      cwd: process.cwd(),
      timeoutMs: 10_000,
    })

    expect(result.success).toBe(true)
    expect(result.stdout).toContain(process.env.SHELL || '/bin/bash')
    expect(result.stdout).toMatch(/node\nv?\d+/)
  })

  it('finds rg using the user shell PATH', async () => {
    const result = await ripgrepSearch('buildNativeShellCommand', new URL('../nativeShell.ts', import.meta.url).pathname, {
      caseSensitive: true,
      maxCount: 1,
    })

    expect(result.success).toBe(true)
    expect(result.matches).toHaveLength(1)
  })
})
