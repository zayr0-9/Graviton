interface ComposerSubmissionState {
  ready: boolean
  hasInput: boolean
  isRetrigger: boolean
  hasModel: boolean
  streamActive: boolean
  compacting: boolean
  modeChanging: boolean
  queueSubmitting: boolean
}

/** Queue intake is safe during compaction; immediate sends must still wait. */
export function getComposerSubmissionAvailability(state: ComposerSubmissionState) {
  const available = state.ready && state.hasModel && !state.modeChanging && !state.queueSubmitting
  return {
    canQueue: available && state.hasInput && state.streamActive,
    canSend: available && !state.streamActive && !state.compacting && (state.hasInput || state.isRetrigger),
  }
}
