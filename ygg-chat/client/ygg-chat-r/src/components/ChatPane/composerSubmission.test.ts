import { describe, expect, it } from 'vitest'
import { getComposerSubmissionAvailability } from './composerSubmission'

const ready = {
  ready: true, hasInput: true, isRetrigger: false, hasModel: true,
  streamActive: false, compacting: false, modeChanging: false, queueSubmitting: false,
}

describe('composer submission availability', () => {
  it('accepts queue intake during compaction without allowing an immediate send', () => {
    expect(getComposerSubmissionAvailability({ ...ready, streamActive: true, compacting: true }))
      .toEqual({ canQueue: true, canSend: false })
  })

  it('keeps compaction without an active stream blocked', () => {
    expect(getComposerSubmissionAvailability({ ...ready, compacting: true }))
      .toEqual({ canQueue: false, canSend: false })
  })

  it.each(['ready', 'hasModel'] as const)('blocks submissions when %s is false', key => {
    expect(getComposerSubmissionAvailability({ ...ready, streamActive: true, compacting: true, [key]: false }))
      .toEqual({ canQueue: false, canSend: false })
  })

  it.each(['modeChanging', 'queueSubmitting'] as const)('blocks duplicate or unavailable submissions when %s', key => {
    expect(getComposerSubmissionAvailability({ ...ready, streamActive: true, compacting: true, [key]: true }))
      .toEqual({ canQueue: false, canSend: false })
  })

  it('only permits empty-input retriggers when idle', () => {
    const retrigger = { ...ready, hasInput: false, isRetrigger: true }
    expect(getComposerSubmissionAvailability(retrigger)).toEqual({ canQueue: false, canSend: true })
    expect(getComposerSubmissionAvailability({ ...retrigger, streamActive: true }))
      .toEqual({ canQueue: false, canSend: false })
  })

  it('preserves normal idle send and active-run queueing', () => {
    expect(getComposerSubmissionAvailability(ready)).toEqual({ canQueue: false, canSend: true })
    expect(getComposerSubmissionAvailability({ ...ready, streamActive: true }))
      .toEqual({ canQueue: true, canSend: false })
  })
})
