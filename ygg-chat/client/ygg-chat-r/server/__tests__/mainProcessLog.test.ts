import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installMainProcessLog, pruneMainProcessLogs } from '../../electron/mainProcessLog.js'

const dirs: string[] = []
const cleanups: Array<() => void> = []
const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'main-log-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  cleanups.splice(0).forEach(cleanup => cleanup())
  dirs.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true }))
  vi.restoreAllMocks()
})

describe('main process log', () => {
  it('keeps today and the previous two days, ignoring unrelated files', () => {
    const dir = tempDir()
    for (const name of ['main-2026-10-27.log', 'main-2026-10-28.log', 'main-2026-10-29.log', 'main-2026-10-30.log', 'client-errors.ndjson']) {
      fs.writeFileSync(path.join(dir, name), 'x')
    }
    const removed = pruneMainProcessLogs(dir, 3, new Date(2026, 9, 30, 9, 0))
    expect(removed).toEqual(['main-2026-10-27.log'])
    expect(fs.readdirSync(dir).sort()).toEqual(['client-errors.ndjson', 'main-2026-10-28.log', 'main-2026-10-29.log', 'main-2026-10-30.log'])
  })

  it('tees console output to a daily file and rolls over with pruning', async () => {
    const dir = tempDir()
    fs.writeFileSync(path.join(dir, 'main-2026-10-26.log'), 'old')
    const passthrough = vi.spyOn(console, 'error').mockImplementation(() => {})
    let now = new Date(2026, 9, 28, 23, 59)
    const log = installMainProcessLog({ logsDir: dir, now: () => now })
    cleanups.push(log.uninstall)

    console.error('[LineageForkDebug][Main] membership-mismatch', { sourceMessageId: 'm1' })
    expect(passthrough).toHaveBeenCalledTimes(1)
    await log.flush()
    const first = fs.readFileSync(path.join(dir, 'main-2026-10-28.log'), 'utf8')
    expect(first).toContain('[error] [LineageForkDebug][Main] membership-mismatch')
    expect(first).toContain("sourceMessageId: 'm1'")
    expect(fs.existsSync(path.join(dir, 'main-2026-10-26.log'))).toBe(true)

    now = new Date(2026, 9, 29, 0, 1)
    console.error('next day')
    await log.flush()
    expect(log.filePath()).toBe(path.join(dir, 'main-2026-10-29.log'))
    expect(fs.readFileSync(log.filePath(), 'utf8')).toContain('next day')
    expect(fs.existsSync(path.join(dir, 'main-2026-10-26.log'))).toBe(false)
  })

  it('stops writing once the daily cap is reached, leaving one marker', async () => {
    const dir = tempDir()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const log = installMainProcessLog({ logsDir: dir, maxBytesPerDay: 300, now: () => new Date(2026, 9, 30, 9, 0) })
    cleanups.push(log.uninstall)
    for (let i = 0; i < 20; i++) console.log(`line ${i} ${'y'.repeat(40)}`)
    await log.flush()
    const text = fs.readFileSync(log.filePath(), 'utf8')
    expect(text.match(/\[log-cap\]/g)).toHaveLength(1)
    expect(text).not.toContain('line 19')
  })

  it('restores the original console on uninstall', () => {
    const original = console.warn
    const log = installMainProcessLog({ logsDir: tempDir() })
    expect(console.warn).not.toBe(original)
    log.uninstall()
    expect(console.warn).toBe(original)
  })
})
