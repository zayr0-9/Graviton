import { describe, expect, it } from 'vitest'
import { runBoundedShell } from '../shellRunner.js'
import { runBashCommand } from '../bash.js'

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
describe.skipIf(process.platform === 'win32')('real bounded shell execution', () => {
  it('kills finite TERM-ignoring descendants even when the leader exits first', async () => {
    const start = Date.now()
    const result = await runBoundedShell(async () => ({ cmd: '/bin/bash', args: ['-c',
      `set +m; bash -c 'trap "" TERM; echo descendant:$$; sleep 8' & wait`] }), { timeoutMs: 200 })
    expect(result).toMatchObject({ success: false, timedOut: true })
    expect(Date.now() - start).toBeLessThan(2000)
    const pid = Number(result.stdout.match(/descendant:(\d+)/)?.[1])
    expect(pid).toBeGreaterThan(0)
    let alive = true
    for (let i = 0; i < 30; i++) {
      try { process.kill(pid, 0) } catch { alive = false; break }
      await pause(20)
    }
    expect(alive).toBe(false)
  })
  it('preserves Bash input, output, and exit status', async () => {
    const result = await runBashCommand('read line; printf "%s" "$line"; exit 7', { input: 'hello\n', successCodes: [7], timeoutMs: 3000 })
    expect(result).toMatchObject({ success: true, stdout: 'hello' })
    expect(await runBashCommand('exit 8', { timeoutMs: 3000 })).toMatchObject({ success: false })
  })
})
