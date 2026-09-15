import { afterEach, describe, expect, it } from 'vitest'
import { ToolOrchestrator } from '../tools/orchestrator/ToolOrchestrator.js'
import { runBashCommand } from '../tools/bash.js'

const orchestrators: ToolOrchestrator[] = []
afterEach(() => {
  for (const orchestrator of orchestrators.splice(0)) orchestrator.shutdown()
})

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

describe.skipIf(process.platform === 'win32')('shell and orchestrator integration', () => {
  it('delivers partial timeout output before the outer job timeout', async () => {
    const orchestrator = new ToolOrchestrator({ persistJobs: false })
    orchestrators.push(orchestrator)
    orchestrator.registerTool('bash', (args, options) => runBashCommand(args.command, {
      ...options,
      env: { SHELL: '/bin/bash' },
      cwd: process.cwd(),
      timeoutMs: 200,
    }))
    const started = Date.now()
    const job = orchestrator.submit('bash', { command: 'printf ready; sleep 3 & wait' }, { timeoutMs: 2500 })
    while (job.status === 'pending' || job.status === 'running') {
      if (Date.now() - started > 3000) throw new Error('Shell did not return its bounded result')
      await pause(20)
    }
    expect(job.status).toBe('completed')
    expect(job.result).toMatchObject({ success: false, timedOut: true, stdout: 'ready' })
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('forwards cancellation to the shell and retains cancelled job state', async () => {
    const orchestrator = new ToolOrchestrator({ persistJobs: false })
    orchestrators.push(orchestrator)
    let signal: AbortSignal | undefined
    let shellResult: Awaited<ReturnType<typeof runBashCommand>> | undefined
    orchestrator.registerTool('bash', async (args, options) => {
      signal = options.signal
      shellResult = await runBashCommand(args.command, {
        ...options, env: { SHELL: '/bin/bash' }, cwd: process.cwd(), timeoutMs: 2000,
      })
      return shellResult
    })
    const job = orchestrator.submit('bash', { command: 'printf ready; sleep 3 & wait' }, { timeoutMs: 4000 })
    await pause(100)
    expect(orchestrator.cancel(job.id)).toBe(true)
    expect(signal?.aborted).toBe(true)
    const cancelledAt = Date.now()
    while (!shellResult && Date.now() - cancelledAt < 1500) await pause(20)
    expect(shellResult).toMatchObject({ success: false, cancelled: true })
    expect(job.status).toBe('cancelled')
  })
})
