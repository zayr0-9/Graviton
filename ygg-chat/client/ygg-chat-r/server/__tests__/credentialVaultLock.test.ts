import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { withCredentialVaultLock } from '../credentialVaultLock.js'

const directories: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })))
})
async function lockPath() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'graviton-lock-test-'))
  directories.push(root)
  return path.join(root, 'lock')
}

describe('credential vault host lock', () => {
  it('serializes distinct host callers sharing the same directory', async () => {
    const directory = await lockPath()
    const events: string[] = []
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const first = withCredentialVaultLock(async () => { events.push('first'); await gate; events.push('first-end') }, directory)
    await vi.waitFor(() => expect(events).toEqual(['first']))
    const second = withCredentialVaultLock(async () => { events.push('second') }, directory)
    release()
    await Promise.all([first, second])
    expect(events).toEqual(['first', 'first-end', 'second'])
    await expect(fs.stat(directory)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('releases the lock when the protected operation fails', async () => {
    const directory = await lockPath()
    await expect(withCredentialVaultLock(async () => { throw new Error('denied') }, directory)).rejects.toThrow('denied')
    expect(await withCredentialVaultLock(async () => 'retry', directory)).toBe('retry')
  })

  it('does not steal a crashed process lock', async () => {
    const directory = await lockPath()
    await fs.mkdir(directory)
    await fs.writeFile(path.join(directory, 'owner.json'), JSON.stringify({ pid: 12345 }))
    vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }) })
    const work = vi.fn(async () => undefined)
    await expect(withCredentialVaultLock(work, directory)).rejects.toThrow('stopped unexpectedly')
    expect(work).not.toHaveBeenCalled()
    expect((await fs.stat(directory)).isDirectory()).toBe(true)
  })
})
