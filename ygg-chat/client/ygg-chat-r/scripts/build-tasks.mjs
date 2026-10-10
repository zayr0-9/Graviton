import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Stop scheduling on failure, but wait for active writers to finish before
// reporting it. Packaging must never start with partial/stale build outputs.
export async function runTasks(tasks, concurrency = 2) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('Invalid build concurrency')
  let next = 0
  let failure
  let failed = false
  async function worker() {
    while (!failed && next < tasks.length) {
      const task = tasks[next++]
      try {
        await task()
      } catch (error) {
        failed = true
        failure ??= error
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker))
  if (failed) throw failure
}

export function runNpmScript(script) {
  const npm = process.env.npm_execpath
  if (!npm) throw new Error('Run this build through npm run')
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [npm, 'run', script], {
      cwd: fileURLToPath(new URL('../', import.meta.url)),
      stdio: 'inherit',
      env: process.env,
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`${script} failed (${signal || code})`))
    })
  })
}
