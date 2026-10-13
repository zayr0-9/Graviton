import { describe, expect, it, vi } from 'vitest'
import { submitMessageDraft } from './messageSubmission'

describe('message draft admission', () => {
  it.each(['Explain', 'branch'])('%s preserves the draft until explicitly accepted', () => {
    const draft = { open: true, text: 'Keep this prompt', selectedText: 'source', images: ['image'] }
    const clear = vi.fn(() => { draft.open = false; draft.text = ''; draft.selectedText = ''; draft.images = [] })
    const rejected = vi.fn(() => false)
    expect(submitMessageDraft(false, rejected, clear)).toBe(false)
    expect(submitMessageDraft(false, undefined, clear)).toBe(false)
    expect(clear).not.toHaveBeenCalled()
    expect(draft).toEqual({ open: true, text: 'Keep this prompt', selectedText: 'source', images: ['image'] })
    const accepted = vi.fn(() => true)
    expect(submitMessageDraft(false, accepted, clear)).toBe(true)
    expect(accepted).toHaveBeenCalledTimes(1)
    expect(clear).toHaveBeenCalledTimes(1)
  })

  it('blocks keyboard admission as well as disabled buttons, then allows the same draft', () => {
    const submit = vi.fn(() => true)
    const clear = vi.fn()
    expect(submitMessageDraft(true, submit, clear)).toBe(false)
    expect(submit).not.toHaveBeenCalled()
    expect(clear).not.toHaveBeenCalled()
    expect(submitMessageDraft(false, submit, clear)).toBe(true)
  })

  it('checks the latest readiness after asynchronous image preparation', async () => {
    let ready!: () => void
    const preparation = new Promise<void>(resolve => { ready = resolve })
    const latest = { disabled: false, submit: vi.fn(() => true) }
    const clear = vi.fn()
    const save = async () => {
      await preparation
      return submitMessageDraft(latest.disabled, latest.submit, clear)
    }
    const pending = save()
    latest.disabled = true
    ready()
    expect(await pending).toBe(false)
    expect(latest.submit).not.toHaveBeenCalled()
    expect(clear).not.toHaveBeenCalled()
  })
})
