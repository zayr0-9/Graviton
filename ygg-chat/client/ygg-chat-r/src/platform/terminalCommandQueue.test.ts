import { describe, expect, it, vi } from 'vitest'
import { TerminalCommandQueue } from './terminalCommandQueue'
describe('terminal HTTP ordering', () => {
  it('orders one terminal while allowing other terminals to proceed', async () => {
    const queue = new TerminalCommandQueue()
    let release!: () => void
    const output: string[] = []
    const first = queue.run('a', () => new Promise<void>(resolve => { output.push('a1'); release = resolve }))
    const second = queue.run('a', async () => { output.push('a2') })
    await queue.run('b', async () => { output.push('b') })
    expect(output).toEqual(['a1', 'b'])
    release(); await first; await second
    expect(output).toEqual(['a1', 'b', 'a2'])
  })
  it('does not dispatch queued input after an uncertain delivery', async () => {
    const queue = new TerminalCommandQueue()
    const later = vi.fn()
    const first = queue.run('a', async () => { throw new Error('lost acknowledgement') })
    const second = queue.run('a', later)
    await expect(first).rejects.toThrow('lost acknowledgement')
    await expect(second).rejects.toThrow('uncertain')
    expect(later).not.toHaveBeenCalled()
    await expect(queue.run('a', later)).rejects.toThrow('uncertain')
  })
})
