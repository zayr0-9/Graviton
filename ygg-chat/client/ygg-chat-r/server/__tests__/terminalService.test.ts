import { afterEach, expect, it, vi } from 'vitest'
import { TerminalService } from '../terminal/terminalService.js'
vi.mock('../terminal/terminalLaunch.js', () => ({
  resolveTerminalLaunch: async () => ({ file: 'fixture', args: [], spawnCwd: '/fixture', displayCwd: '/fixture', shellLabel: 'fixture' }),
  clampTerminalDimension: (value: number, fallback: number) => value ?? fallback,
}))
afterEach(() => vi.useRealTimers())
it('owns separate PTYs, replays bounded output, deduplicates create and expires disconnected sessions', async () => {
  vi.useFakeTimers()
  const processes: any[] = []
  const spawn = vi.fn(() => {
    const pty = { write: vi.fn(), resize: vi.fn(), kill: vi.fn(), onData: (fn: any) => { pty.data = fn }, onExit: (fn: any) => { pty.exit = fn }, data: (_: string) => {}, exit: (_: any) => {} }
    processes.push(pty); return pty as any
  })
  const service = new TerminalService(spawn)
  try {
    const a = await service.create('a', 'request', { cwd: '/fixture' })
    const b = await service.create('b', 'request', { cwd: '/fixture' })
    expect(await service.create('a', 'request', { cwd: '/fixture' })).toEqual(a)
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(() => service.write('b', a.sessionId, 'wrong')).toThrow('unavailable')
    service.write('a', a.sessionId, 'hello')
    expect(processes[0].write).toHaveBeenCalledWith('hello')
    processes[0].data('out')
    expect(service.read('a', a.sessionId, 0).events).toEqual([{ seq: 1, data: 'out' }])
    processes[0].data('x'.repeat(1024 * 1024 + 1))
    expect(service.read('a', a.sessionId, 0).truncated).toBe(true)
    service.kill('a', a.sessionId)
    expect(processes[0].kill).toHaveBeenCalledOnce()
    expect(processes[1].kill).not.toHaveBeenCalled()
    vi.advanceTimersByTime(65000)
    expect(processes[1].kill).toHaveBeenCalledOnce()
    expect(() => service.read('b', b.sessionId, 0)).toThrow('unavailable')
  } finally { service.shutdown() }
})
