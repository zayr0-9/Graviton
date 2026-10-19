import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { createRunSubscriber } from './runSubscriber.js'

function response() {
  const res = Object.assign(new EventEmitter(), {
    writableEnded: false, destroyed: false,
    write: vi.fn((_value: string) => true),
    end: vi.fn(), destroy: vi.fn(),
  })
  return res
}
const frame = (seq: number) => ({ seq, event: { type: 'chunk', part: 'text', delta: 'x' } as const })
describe('bounded observer transport', () => {
  it('queues while blocked, drains in order and finishes after queued terminal data', () => {
    const res = response()
    res.write.mockReturnValueOnce(false)
    const viewer = createRunSubscriber(res as any)
    viewer.send(frame(1)); viewer.send(frame(2)); viewer.end()
    expect(res.end).not.toHaveBeenCalled()
    res.emit('drain')
    expect(res.write.mock.calls.map(([data]) => JSON.parse(data.slice(6)).seq)).toEqual([1, 2])
    expect(res.end).toHaveBeenCalledOnce()
    expect(res.listenerCount('drain')).toBe(0)
  })
  it('disconnects only its overflowing socket', () => {
    const res = response()
    res.write.mockReturnValue(false)
    const viewer = createRunSubscriber(res as any, 1)
    viewer.send(frame(1)); viewer.send(frame(2))
    expect(res.destroy).toHaveBeenCalledOnce()
    expect(res.listenerCount('drain')).toBe(0)
  })
})
