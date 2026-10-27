import { useEffect, useState, type CSSProperties } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { chatSliceActions } from '../../features/chats/chatSlice'
import type { AppDispatch, RootState } from '../../store/store'
import type { ChatMessageProps } from './ChatMessage'
import { SummarisedMessage } from './SummarisedMessage'
import { TextArea } from '../TextArea/TextArea'
import { getCustomChatThemeEnabled, getStoredCustomChatTheme, getThemeModeColor } from '../ThemeManager/themeConfig'

/** Summary content stays display-only; a branch adds a new request after it. */
export function SummaryBranchMessage(props: ChatMessageProps) {
  const dispatch = useDispatch<AppDispatch>()
  const [editing, setEditing] = useState(false)
  const [content, setContent] = useState('')
  const ownsEditor = useSelector((state: RootState) => state.chat.composition.editingBranch && String(state.chat.composition.branchEditMessageId) === String(props.id))
  useEffect(() => { if (!ownsEditor) setEditing(false) }, [ownsEditor])
  const close = () => {
    setEditing(false)
    dispatch(chatSliceActions.editingBranchSet(false))
    props.onEditingStateChange?.(props.id, false, 'branch')
  }
  const submit = () => {
    if (!content.trim() || props.branchSubmissionDisabled) return
    if (props.onBranch?.(props.id, content.trim())) close()
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
  return <div className={`${props.width} ${props.className ?? ''}`}>
    <SummarisedMessage id={`message-${props.id}`} customTheme={props.customTheme}
      customThemeEnabled={props.customThemeEnabled} isDarkMode={props.isDarkMode}
      action={!props.readOnly && props.onBranch && !editing ? <button type='button'
        style={buttonStyle}
        className='ml-1 inline-flex shrink-0 items-center rounded-full bg-[var(--summary-action-bg,rgba(120,113,108,0.1))] px-3 py-1 text-xs font-medium text-[var(--summary-action-text,#57534e)] backdrop-blur-xl transition-[background-color,color,transform] duration-150 hover:bg-[var(--summary-action-hover-bg,rgba(120,113,108,0.18))] hover:text-[var(--summary-action-hover-text,#292524)] active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/70 dark:text-[var(--summary-action-text,#d6d3d1)] dark:hover:text-[var(--summary-action-hover-text,#fafaf9)] dark:focus-visible:ring-orange-400/70 motion-reduce:transition-none motion-reduce:active:scale-100'
        onClick={() => {
          setEditing(true)
          dispatch(chatSliceActions.editingBranchSet(true))
          dispatch(chatSliceActions.branchEditMessageSelected(props.id))
          props.onEditingStateChange?.(props.id, true, 'branch')
        }}>branch here</button> : undefined} />
    {editing && <div className='px-2 py-1'>
      <TextArea value={content} onChange={setContent} placeholder='Continue from this summary...'
        label='Create new branch' minRows={2} maxRows={12} autoFocus width='w-full'
        onKeyDown={event => {
          if (event.key === 'Escape') { event.preventDefault(); close() }
          if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submit() }
        }} />
      <div className='flex justify-end gap-3 py-1 text-xs'>
        <button type='button' onClick={close}>Cancel</button>
        <button type='button' disabled={!content.trim() || props.branchSubmissionDisabled} onClick={submit}>Create branch</button>
      </div>
    </div>}
  </div>
}
