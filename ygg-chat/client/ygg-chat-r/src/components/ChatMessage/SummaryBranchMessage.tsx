import { useEffect, useState, type CSSProperties } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { chatSliceActions } from '../../features/chats/chatSlice'
import type { AppDispatch, RootState } from '../../store/store'
import type { ChatMessageProps } from './ChatMessage'
import { SummarisedMessage } from './SummarisedMessage'
import { TextArea } from '../TextArea/TextArea'
import { getCustomChatThemeEnabled, getStoredCustomChatTheme, getThemeModeColor } from '../ThemeManager/themeConfig'

const SUMMARY_ACTION_CLASS = 'ml-1 inline-flex shrink-0 items-center rounded-full bg-[var(--summary-action-bg,rgba(120,113,108,0.1))] px-3 py-1 text-xs font-medium text-[var(--summary-action-text,#57534e)] backdrop-blur-xl transition-[background-color,color,transform] duration-150 hover:bg-[var(--summary-action-hover-bg,rgba(120,113,108,0.18))] hover:text-[var(--summary-action-hover-text,#292524)] active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/70 dark:text-[var(--summary-action-text,#d6d3d1)] dark:hover:text-[var(--summary-action-hover-text,#fafaf9)] dark:focus-visible:ring-orange-400/70 motion-reduce:transition-none motion-reduce:active:scale-100'

export type SummaryBranchMessageProps = ChatMessageProps & {
  /** Continue from the last real message before the summary, keeping the uncompacted context. */
  onBranchBeforeSummary?: (id: string, content: string) => boolean
  branchBeforeSummaryDisabled?: boolean
}

/**
 * Summary content stays display-only. "branch here" adds a new request after the summary;
 * "branch before summary" adds one under the message the summary replaced.
 */
export function SummaryBranchMessage(props: SummaryBranchMessageProps) {
  const dispatch = useDispatch<AppDispatch>()
  const [editing, setEditing] = useState<'summary' | 'before' | null>(null)
  const [content, setContent] = useState('')
  const ownsEditor = useSelector((state: RootState) => state.chat.composition.editingBranch && String(state.chat.composition.branchEditMessageId) === String(props.id))
  // Only "branch here" is a composer branch edit (it may switch provider/model); the other is local.
  useEffect(() => { if (!ownsEditor) setEditing(mode => mode === 'summary' ? null : mode) }, [ownsEditor])
  const close = () => {
    const mode = editing
    setEditing(null)
    if (mode !== 'summary') return
    dispatch(chatSliceActions.editingBranchSet(false))
    props.onEditingStateChange?.(props.id, false, 'branch')
  }
  const disabled = editing === 'before' ? props.branchBeforeSummaryDisabled : props.branchSubmissionDisabled
  const submit = () => {
    if (!content.trim() || disabled) return
    const branch = editing === 'before' ? props.onBranchBeforeSummary : props.onBranch
    if (branch?.(props.id, content.trim())) close()
  }
  const theme = props.customTheme ?? getStoredCustomChatTheme()
  const themeEnabled = props.customThemeEnabled ?? getCustomChatThemeEnabled()
  const isDarkMode = props.isDarkMode ?? (typeof document !== 'undefined' && document.documentElement.classList.contains('dark'))
  const buttonStyle = themeEnabled ? {
    '--summary-action-bg': getThemeModeColor(theme.colors.settingsCustomThemesButtonBg, isDarkMode),
    '--summary-action-text': getThemeModeColor(theme.colors.settingsCustomThemesButtonText, isDarkMode),
    '--summary-action-hover-bg': getThemeModeColor(theme.colors.composerToggleActiveBg, isDarkMode),
    '--summary-action-hover-text': getThemeModeColor(theme.colors.composerToggleActiveText, isDarkMode),
  } as CSSProperties : undefined
  const showActions = !props.readOnly && !editing && (props.onBranch || props.onBranchBeforeSummary)
  return <div className={`${props.width} ${props.className ?? ''}`}>
    <SummarisedMessage id={`message-${props.id}`} customTheme={props.customTheme}
      customThemeEnabled={props.customThemeEnabled} isDarkMode={props.isDarkMode}
      action={showActions ? <>
        {props.onBranchBeforeSummary && <button type='button' style={buttonStyle} className={SUMMARY_ACTION_CLASS}
          title='Start a new branch from the last message before this summary, with the full earlier context'
          onClick={() => setEditing('before')}>branch before summary</button>}
        {props.onBranch && <button type='button' style={buttonStyle} className={SUMMARY_ACTION_CLASS}
          onClick={() => {
            setEditing('summary')
            dispatch(chatSliceActions.editingBranchSet(true))
            dispatch(chatSliceActions.branchEditMessageSelected(props.id))
            props.onEditingStateChange?.(props.id, true, 'branch')
          }}>branch here</button>}
      </> : undefined} />
    {editing && <div className='px-2 py-1'>
      <TextArea value={content} onChange={setContent}
        placeholder={editing === 'before' ? 'Continue from before the summary...' : 'Continue from this summary...'}
        label={editing === 'before' ? 'Branch before summary' : 'Create new branch'} minRows={2} maxRows={12} autoFocus width='w-full'
        onKeyDown={event => {
          if (event.key === 'Escape') { event.preventDefault(); close() }
          if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submit() }
        }} />
      <div className='flex justify-end gap-3 py-1 text-xs'>
        <button type='button' onClick={close}>Cancel</button>
        <button type='button' disabled={!content.trim() || disabled} onClick={submit}>Create branch</button>
      </div>
    </div>}
  </div>
}
