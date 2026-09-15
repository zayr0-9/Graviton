import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import { afterEach, expect, it, vi } from 'vitest'
import * as cp from 'child_process'
import { getDefaultDistro } from '../../utils/wslBridge.js'

vi.mock('child_process', () => ({ execFile: vi.fn() }))
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks() })
it('bounds a never-callback WSL discovery and forwards signal/timeout', async () => {
  vi.useFakeTimers()
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(), unref: vi.fn() })
  vi.mocked(cp.execFile).mockReturnValue(child as any)
  const controller = new AbortController()
  const result = getDefaultDistro({ signal: controller.signal, deadlineMs: Date.now() + 20 }).catch(error => error)
  await vi.advanceTimersByTimeAsync(20)
  expect(await result).toBeInstanceOf(Error)
  expect(cp.execFile).toHaveBeenCalledWith('wsl.exe', ['--list', '--verbose'], expect.objectContaining({ signal: controller.signal, timeout: 20 }), expect.any(Function))
  expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  expect(vi.getTimerCount()).toBe(0)
})
it('does not discover after pre-abort', async () => {
  const controller = new AbortController(); controller.abort()
  await expect(getDefaultDistro({ signal: controller.signal })).rejects.toThrow('stopped')
  expect(cp.execFile).not.toHaveBeenCalled()
})
