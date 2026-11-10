import { describe, expect, it } from 'vitest'
import { RunSession } from '../runSessionRegistry.js'
import { installChildRunSnapshot } from '../childRunSnapshot.js'
describe('child snapshot boundary', () => {
  it('bootstraps the current tail after replay eviction without replacing other observers', () => {
    const session = new RunSession('child', 'conversation', 1)
    installChildRunSnapshot(session, 'run')
    session.publish({ type: 'chunk', part: 'text', delta: 'one' })
    session.publish({ type: 'chunk', part: 'reasoning', delta: 'thinking' })
    session.publish({ type: 'chunk', part: 'text', delta: 'two' })
    const a: any[] = []; const b: any[] = []
    session.attachSnapshot({ send: frame => a.push(frame), end: () => {} })
    session.attachSnapshot({ send: frame => b.push(frame), end: () => {} })
    expect(a[0]).toMatchObject({ seq: 3, event: { type: 'child_bootstrap', snapshot: { kind: 'child', text: 'onetwo', reasoning: 'thinking', stateSeq: 3 } } })
    session.publish({ type: 'chunk', part: 'text', delta: 'three' })
    expect(a[1].seq).toBe(4); expect(b[1].seq).toBe(4)
    expect(session.kind).toBe('child')
  })
  it('resets completed output at persistence', () => {
    const session = new RunSession('child', 'conversation')
    installChildRunSnapshot(session, 'run')
    session.publish({ type: 'chunk', part: 'text', delta: 'persisted' })
    session.publish({ type: 'assistant_message_persisted', message: { id: 'm' } })
    const frames: any[] = []
    session.attachSnapshot({ send: frame => frames.push(frame), end: () => {} })
    expect(frames[0].event.snapshot.text).toBe('')
  })
})
