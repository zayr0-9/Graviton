import type { AppDispatch, RootState } from '../../store/store'
import type { AgentForkGroup } from '../../hooks/useRunningAgentStreams'
import { newClientId } from '../../helpers/clientId'
import { getPendingFullAccessNotification, isFullAccessEnabled } from '../../helpers/fullAccessSettings'
import { runningAgentsUiActions as actions } from '../ui/runningAgentsUiSlice'
import { findFollowUpKey, relatedFollowUpKeys, type AgentFollowUpAttempt } from '../ui/agentFollowUpState'
import { getAdmissionEpoch } from './runAdmissionClient'
import { enqueueUserMessage } from './chatActions'

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

/** Redux owns the submission lock, so remounts and duplicate surfaces cannot double-submit. */
export const submitAgentFollowUp = (fork: AgentForkGroup, confirmPolicy = false, selectedDraftKey?: string) =>
  async (dispatch: AppDispatch, getState: () => RootState) => {
    const target = followUpTarget(fork)
    const drafts = getState().runningAgentsUi.followUps
    const related = relatedFollowUpKeys(drafts, fork.key, target.streamIds)
    const key = selectedDraftKey && related.includes(selectedDraftKey) ? selectedDraftKey : findFollowUpKey(drafts, fork.key, target.streamIds)
    const draft = drafts[key]
    if (!draft || related.some(id => ['preparing', 'sending'].includes(drafts[id].status))) return
    // A merged unresolved run may carry an uncertain attempt. Reconcile it first.
    if (related.some(id => id !== key && drafts[id].status === 'unknown')) return
    const retry = draft.status === 'unknown' ? draft.attempt : undefined
    const policyAttempt = confirmPolicy && draft.policy !== undefined ? draft.attempt : undefined
    if (!retry && !policyAttempt && (target.reason || !draft.content.trim())) return
    dispatch(actions.followUpPreparing(key))
    let attempt: AgentFollowUpAttempt
    try {
      attempt = retry ?? (policyAttempt ? {
        ...policyAttempt, requestId: newClientId(), preparedTextSubmission: {
          ...policyAttempt.preparedTextSubmission, fullAccess: draft.policy!,
        },
      } : {
        conversationId: target.run.conversationId!, streamId: target.run.streamId,
        content: draft.content, revision: draft.revision, requestId: newClientId(),
        preparedTextSubmission: { epoch: await getAdmissionEpoch(), fullAccess: isFullAccessEnabled(),
          fullAccessNotificationId: getPendingFullAccessNotification(target.run.conversationId!) },
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
