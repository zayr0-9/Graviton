import { useEffect, useState } from 'react'
import { useStore } from 'react-redux'
import type { RootState } from '../../store/store'
import type { AgentForkGroup, AgentStreamListItem } from '../../hooks/useRunningAgentStreams'
import { useAppDispatch, useAppSelector } from '../../hooks/redux'
import { followUpTarget, submitAgentFollowUp } from '../../features/chats/agentFollowUp'
import { cancelQueuedMessage } from '../../features/chats/chatActions'
import { runningAgentsUiActions } from '../../features/ui/runningAgentsUiSlice'
import { findFollowUpKey, relatedFollowUpKeys, followUpCapacity, MAX_FOLLOW_UP_LENGTH } from '../../features/ui/agentFollowUpState'
import { QueuedMessages } from '../ChatMessage/QueuedMessages'
import { getThemeModeColor, useCustomChatTheme, useHtmlDarkMode } from '../ThemeManager/themeConfig'

export function AgentFollowUpComposer({ fork, onOpenChat }: {
  fork: AgentForkGroup; onOpenChat: (stream: AgentStreamListItem) => void
}) {
  const dispatch = useAppDispatch()
  const store = useStore<RootState>()
  const target = followUpTarget(fork)
  const [selectedDraftKey, setSelectedDraftKey] = useState<string | null>(null)
  const relatedJson = useAppSelector(state => JSON.stringify(relatedFollowUpKeys(state.runningAgentsUi?.followUps ?? {}, fork.key, target.streamIds)))
  const relatedKeys: string[] = JSON.parse(relatedJson)
  const defaultKey = useAppSelector(state => findFollowUpKey(state.runningAgentsUi?.followUps ?? {}, fork.key, target.streamIds))
  const key = selectedDraftKey && relatedKeys.includes(selectedDraftKey) ? selectedDraftKey : defaultKey
  const blockedByOther = useAppSelector(state => relatedKeys.some(id => id !== key &&
    ['preparing', 'sending', 'unknown'].includes(state.runningAgentsUi.followUps[id]?.status)))
  const draft = useAppSelector(state => state.runningAgentsUi?.followUps?.[key])
  const identity = JSON.stringify(target.streamIds)
  const hasDraft = !!draft
  useEffect(() => {
    if (hasDraft) dispatch(runningAgentsUiActions.followUpLinked({ key, forkKey: fork.key, streamIds: JSON.parse(identity) }))
  }, [dispatch, key, fork.key, identity, hasDraft])
  const acceptedStreamId = draft?.acceptedStreamId
  const queue = useAppSelector(state => state.chat?.messageQueues?.[fork.activeStreams[0]?.streamId ?? acceptedStreamId ?? target.run.streamId])
  const [capacityError, setCapacityError] = useState('')
  const [inputFocused, setInputFocused] = useState(false)
  const { theme, enabled } = useCustomChatTheme()
  const dark = useHtmlDarkMode()
  const color = (name: 'toolJobsPrimaryText' | 'toolJobsMutedText' | 'settingsCustomThemesInnerCardBg' | 'toolJobsErrorText' | 'composerToggleActiveBg' | 'composerToggleActiveText') =>
    enabled ? getThemeModeColor(theme.colors[name], dark) : undefined
  const change = (content: string) => {
    const drafts = store.getState().runningAgentsUi.followUps
    if (!followUpCapacity(drafts, key, content)) {
      setCapacityError('Draft limit reached. Shorten or clear another agent draft first.')
      return
    }
    setCapacityError('')
    dispatch(runningAgentsUiActions.followUpChanged({ key, content, streamIds: target.streamIds }))
  }
  const busy = draft?.status === 'preparing' || draft?.status === 'sending'
  const uncertain = draft?.status === 'unknown'
  const disabled = busy || blockedByOther || (!uncertain && (!!target.reason || !draft?.content.trim()))
  const submit = () => { if (!disabled) void dispatch(submitAgentFollowUp(fork, false, key)) }
  const error = capacityError || draft?.error || target.reason
  return <div className='shrink-0 px-3 pb-3 pt-2 text-xs' style={{ color: color('toolJobsPrimaryText') }}>
    {queue && <QueuedMessages items={queue.items}
      onCancel={requestId => dispatch(cancelQueuedMessage({ conversationId: target.run.conversationId!, streamId: queue.streamId, requestId })).unwrap()}
      onRestore={content => change(draft?.content ? `${draft.content}\n\n${content}` : content)} />}
    {relatedKeys.length > 1 && <label className='mb-1 block'>Saved draft <select value={key} onChange={event => setSelectedDraftKey(event.target.value)}>
      {relatedKeys.map((id, index) => <option key={id} value={id}>Draft {index + 1}</option>)}
    </select></label>}
    {blockedByOther && <p role='status'>Another saved draft is sending or awaiting reconciliation. Select it to retry.</p>}
    <textarea aria-label={`Follow up with ${fork.displayName}`} placeholder='Send a follow-up…'
      className='block min-h-10 max-h-32 w-full resize-y rounded-xl bg-white/60 p-2 text-sm outline-none dark:bg-black/20'
      onFocus={() => setInputFocused(true)} onBlur={() => setInputFocused(false)}
      style={{ backgroundColor: color('settingsCustomThemesInnerCardBg'), color: color('toolJobsPrimaryText') }}
      rows={2} maxLength={MAX_FOLLOW_UP_LENGTH} value={draft?.content ?? ''} onChange={event => change(event.target.value)}
      onKeyDown={event => {
        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
          event.preventDefault(); event.stopPropagation(); submit()
        }
      }} />
    <div className='mt-1 flex items-center justify-end gap-2'>
      {draft?.policy !== undefined && <button type='button' disabled={busy || blockedByOther} className='rounded-full px-2 py-1 hover:bg-black/5 dark:hover:bg-white/10'
        onClick={() => { void dispatch(submitAgentFollowUp(fork, true, key)) }}>
        Use run’s {draft.policy ? 'Full access' : 'restricted access'}
      </button>}
      <button type='button' disabled={disabled} onClick={submit}
        className={`rounded-full px-3 py-1 font-medium transition-colors disabled:opacity-50 ${inputFocused
          ? 'bg-black/10 dark:bg-white/15' : 'hover:bg-black/5 dark:hover:bg-white/10'}`}
        style={inputFocused ? { backgroundColor: color('composerToggleActiveBg'), color: color('composerToggleActiveText') } : undefined}>
        {busy ? 'Sending…' : uncertain ? 'Retry' : fork.activeStreams.length ? 'Queue' : 'Send'}
      </button>
    </div>
    {draft?.status === 'rejected' && draft.attempt && draft.attempt.content !== draft.content &&
      <button type='button' className='mt-1 underline' onClick={() => change(draft.content ? `${draft.content}\n\n${draft.attempt!.content}` : draft.attempt!.content)}>Restore submitted text</button>}
    {error && <div role='alert' className='mt-1 text-rose-700 dark:text-rose-300' style={{ color: color('toolJobsErrorText') }}>
      {error} <button type='button' disabled={!target.run.conversationId} className='underline' onClick={() => onOpenChat(target.run)}>Open chat</button>
    </div>}
    {draft?.status === 'accepted' && !error && <p role='status' style={{ color: color('toolJobsMutedText') }}>Instruction accepted.</p>}
  </div>
}
