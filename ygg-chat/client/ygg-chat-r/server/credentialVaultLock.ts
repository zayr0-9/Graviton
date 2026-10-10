import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/** Shared by desktop and standalone hosts, independent of their project paths.
 * Do not automatically steal stale locks: deleting another process's replacement
 * lock can lose credentials. A crashed owner produces an actionable error instead.
 */
export async function withCredentialVaultLock<T>(work: () => Promise<T>, directory = path.join(os.homedir(), '.graviton-credential-lock')): Promise<T> {
  const ownerPath = path.join(directory, 'owner.json')
  const deadline = Date.now() + 15_000
  while (true) {
    try {
      await fs.mkdir(directory, { mode: 0o700 })
      try {
        await fs.writeFile(ownerPath, JSON.stringify({ pid: process.pid }), { mode: 0o600 })
      } catch (error) {
        await fs.rmdir(directory).catch(() => undefined)
        throw error
      }
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      try {
        const owner = JSON.parse(await fs.readFile(ownerPath, 'utf8')) as { pid: number }
        if (Number.isSafeInteger(owner.pid) && owner.pid > 0) {
          try { process.kill(owner.pid, 0) } catch (pidError) {
            if ((pidError as NodeJS.ErrnoException).code === 'ESRCH') {
              throw new Error(`A previous credential operation stopped unexpectedly. Close Graviton and its standalone servers, remove ${directory}, and retry.`)
            }
          }
        }
      } catch (ownerError) {
        if (ownerError instanceof Error && ownerError.message.startsWith('A previous credential')) throw ownerError
        // The owner may still be publishing its PID. Wait, but never steal it.
      }
      if (Date.now() >= deadline) throw new Error(`Credential storage is busy. Retry after other Graviton credential operations finish. If none are running, close all Graviton hosts and remove ${directory}.`)
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
  try { return await work() } finally {
    await fs.unlink(ownerPath)
    await fs.rmdir(directory)
  }
}
