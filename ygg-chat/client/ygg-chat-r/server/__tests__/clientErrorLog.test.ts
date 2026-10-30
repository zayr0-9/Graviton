import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CLIENT_ERROR_LOG_FILENAME, createClientErrorLog, pruneClientErrorLog } from '../../electron/clientErrorLog.js'

const dirs: string[] = []
const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'client-error-log-'))
  dirs.push(dir)
  return dir
}
const record = (date: Date, type = 'console_error') => JSON.stringify({ ts: date.toISOString(), type, args: ['x'] })

afterEach(() => {
  dirs.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true }))
})

describe('client error log retention', () => {
  it('keeps today and the previous two local days, dropping older and unreadable records', () => {
    const dir = tempDir()
    const file = path.join(dir, CLIENT_ERROR_LOG_FILENAME)
    const lines = [
      record(new Date(2026, 9, 27, 23, 59)),
      'not json',
      record(new Date(2026, 9, 28, 0, 0)),
      record(new Date(2026, 9, 30, 8, 0)),
    ]
    fs.writeFileSync(file, `${lines.join('\n')}\n`)
    expect(pruneClientErrorLog(file, 3, new Date(2026, 9, 30, 9, 0))).toBe(2)
    expect(fs.readFileSync(file, 'utf-8')).toBe(`${lines[2]}\n${lines[3]}\n`)
  })

  it('reads timestamps that are not the leading key and leaves a fresh file untouched', () => {
    const dir = tempDir()
    const file = path.join(dir, CLIENT_ERROR_LOG_FILENAME)
    const content = `${JSON.stringify({ type: 'renderer_recovery', ts: new Date(2026, 9, 30, 1).toISOString() })}\n`
    fs.writeFileSync(file, content)
    const before = fs.statSync(file).mtimeMs
    expect(pruneClientErrorLog(file, 3, new Date(2026, 9, 30, 9))).toBe(0)
    expect(fs.readFileSync(file, 'utf-8')).toBe(content)
    expect(fs.statSync(file).mtimeMs).toBe(before)
  })

  it('prunes at startup and again on the first append of a new day', () => {
    const dir = tempDir()
    const file = path.join(dir, CLIENT_ERROR_LOG_FILENAME)
    let now = new Date(2026, 9, 30, 9)
    fs.writeFileSync(file, `${record(new Date(2026, 9, 20))}\n${record(new Date(2026, 9, 28, 12))}\n`)
    const log = createClientErrorLog({ logsDir: dir, now: () => now })
    expect(fs.readFileSync(file, 'utf-8').trim().split('\n')).toHaveLength(1)

    log.append(`${record(now)}\n`)
    expect(fs.readFileSync(file, 'utf-8').trim().split('\n')).toHaveLength(2)

    now = new Date(2026, 9, 31, 0, 5)
    log.append(`${record(now)}\n`)
    // The 28th fell out of the window at midnight; the 30th and 31st remain.
    const days = fs.readFileSync(file, 'utf-8').trim().split('\n').map(line => new Date(JSON.parse(line).ts).getDate())
    expect(days).toEqual([30, 31])
  })

  it('creates the logs directory and file path on demand', () => {
    const dir = path.join(tempDir(), 'nested', 'logs')
    const log = createClientErrorLog({ logsDir: dir, now: () => new Date(2026, 9, 30) })
    log.append(`${record(new Date(2026, 9, 30))}\n`)
    expect(log.filePath()).toBe(path.join(dir, CLIENT_ERROR_LOG_FILENAME))
    expect(fs.existsSync(log.filePath())).toBe(true)
  })
})
