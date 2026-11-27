import type { AppDispatch, RootState } from '../../store/store'
import type { AgentForkGroup } from '../../hooks/useRunningAgentStreams'
import { newClientId } from '../../helpers/clientId'
import { readChatDisplayName } from '../../helpers/chatDisplayName'
import { resolveLineageFullAccess } from './branchFullAccess'
import { runningAgentsUiActions as actions } from '../ui/runningAgentsUiSlice'
import { findFollowUpKey, relatedFollowUpKeys, type AgentFollowUpAttempt } from '../ui/agentFollowUpState'
import { getAdmissionEpoch } from './runAdmissionClient'
import { changeOperationMode, enqueueUserMessage } from './chatActions'
import type { OperationMode } from './chatTypes'
import { chatSliceActions } from './chatSlice'

/**
 * Move a follow-up draft the pill could not send into Chat's composer, appended after any
 * text already there, and empty the pill draft so the text exists in one place only.
 * Skipped while a send is in flight or delivery is unknown (the host may already have it).
 */
export const moveFollowUpToComposer = (key: string) =>
  (dispatch: AppDispatch, getState: () => RootState): boolean => {
    const draft = getState().runningAgentsUi.followUps[key]
    if (!draft || ['preparing', 'sending', 'unknown'].includes(draft.status)) return false
    const text = draft.content.trim() ? draft.content : draft.attempt?.content ?? ''
    if (!text.trim()) return false
    const existing = getState().chat.composition.input.content
    dispatch(chatSliceActions.inputChanged({ content: existing.trim() ? `${existing.trimEnd()}\n\n${text}` : text }))
    dispatch(actions.followUpChanged({ key, content: '', streamIds: draft.streamIds }))
    return true
  }

export function followUpTarget(fork: AgentForkGroup) {
  const runs = [...fork.activeStreams, ...fork.completedStreams]
  const streamIds = runs.map(run => run.streamId)
  const run = fork.representative
  const supported = runs.every(item => item.streamType === 'primary' || item.streamType === 'branch')
  const reason = !supported ? 'This run does not support chat follow-ups.'
    : !run.conversationId ? 'Conversation unavailable.'
    : fork.activeStreams.length > 1 ? 'Multiple executions are active. Open chat to continue.'
    : run.hasError || run.status === 'aborting' || run.status === 'error' ? 'This run stopped or failed. Open chat to continue.' : undefined
  return { streamIds, run, reason }
}

/** The mode the fork's newest run reported; null when no run has reported one yet. */
export function forkOperationMode(fork: AgentForkGroup): OperationMode | null {
  return fork.representative.operationMode ??
    [...fork.activeStreams, ...fork.completedStreams].find(run => run.operationMode)?.operationMode ?? null
}

/**
 * Chat/Agent toggle on a fork card. A single live run switches immediately through the
 * live mode route, like Chat's toggle. Otherwise (or when the run ended before the switch
 * landed) the choice is kept on the draft and starts the follow-up run in that mode.
 */
export const selectAgentFollowUpMode = (fork: AgentForkGroup, key: string, mode: OperationMode) =>
  async (dispatch: AppDispatch) => {
    const target = followUpTarget(fork)
    const live = fork.activeStreams.length === 1 ? fork.activeStreams[0] : null
    if (live?.conversationId && !target.reason) {
      const result = await dispatch(changeOperationMode({ mode, conversationId: live.conversationId,
        streamId: live.streamId, parentId: null, lineageId: live.lineageIdConfirmed ? live.lineageId : null }))
      if (changeOperationMode.fulfilled.match(result)) return
    }
    dispatch(actions.followUpModeChanged({ key, mode, streamIds: target.streamIds }))
  }

/** Redux owns the submission lock, so remounts and duplicate surfaces cannot double-submit. */
export const submitAgentFollowUp = (fork: AgentForkGroup, confirmPolicy = false, selectedDraftKey?: string) =>
  async (dispatch: AppDispatch, getState: () => RootState) => {
    const target = followUpTarget(fork)
    const state = getState()
    const drafts = state.runningAgentsUi.followUps
    const related = relatedFollowUpKeys(drafts, fork.key, target.streamIds)
    const key = selectedDraftKey && related.includes(selectedDraftKey) ? selectedDraftKey : findFollowUpKey(drafts, fork.key, target.streamIds)
    const draft = drafts[key]
    if (!draft || related.some(id => ['preparing', 'sending'].includes(drafts[id].status))) return
    // A merged unresolved run may carry an uncertain attempt. Reconcile it first.
    if (related.some(id => id !== key && drafts[id].status === 'unknown')) return
    const retry = draft.status === 'unknown' ? draft.attempt : undefined
    const policyAttempt = confirmPolicy && draft.policy !== undefined ? draft.attempt : undefined
    if (!retry && !policyAttempt && (target.reason || !draft.content.trim())) return
    const access = resolveLineageFullAccess(state.chat, target.run.conversationId!, target.run.lineageIdConfirmed ? target.run.lineageId : null)
    dispatch(actions.followUpPreparing(key))
    let attempt: AgentFollowUpAttempt
    try {
      attempt = retry ?? (policyAttempt ? {
        ...policyAttempt, requestId: newClientId(), preparedTextSubmission: {
          ...policyAttempt.preparedTextSubmission, fullAccess: draft.policy!, fullAccessNotificationId: undefined,
        },
      } : {
        conversationId: target.run.conversationId!, streamId: target.run.streamId,
        content: draft.content, revision: draft.revision, requestId: newClientId(),
        userDisplayName: readChatDisplayName(),
        ...(draft.operationMode ? { operationMode: draft.operationMode } : {}),
        preparedTextSubmission: { epoch: await getAdmissionEpoch(), ...access },
      })
    } catch (error) {
      dispatch(actions.followUpSettled({ key, error: error instanceof Error ? error.message : 'Could not contact the host.' }))
      return
    }
    dispatch(actions.followUpStarted({ key, attempt }))
    const result = await dispatch(enqueueUserMessage({ ...attempt, includeGlobalComposerContext: false, updatePath: false }))
    if (enqueueUserMessage.fulfilled.match(result)) {
      dispatch(actions.followUpSettled({ key, requestId: attempt.requestId, streamId: result.payload.streamId }))
    } else {
      const failure = result.payload
      dispatch(actions.followUpSettled({ key, requestId: attempt.requestId,
        error: failure?.message ?? result.error.message ?? 'Could not queue instruction.',
        uncertain: failure?.uncertain ?? true,
        policy: failure?.code === 'configuration_mismatch' ? failure.fullAccess : undefined }))
    }
  }
