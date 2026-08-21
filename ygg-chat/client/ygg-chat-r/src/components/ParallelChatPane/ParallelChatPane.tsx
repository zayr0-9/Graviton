import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, Settings } from 'lucide-react'
import { ConversationId, MessageId, ReasoningConfig } from '../../../../../shared/types'
import type { ChatErrorActionKind } from '../../../../../shared/chatErrors'
import type { ChatErrorRecord, LineageId, ToolCall } from '../../features/chats/chatTypes'
import {
  abortGeneration,
  cancelPlanClarification,
  chatSliceActions,
  respondToOperationModeUpgrade,
  respondToPlanClarification,
  respondToToolPermission,
  respondToToolPermissionAndEnableAll,
  selectCurrentViewStreamFor,
  selectDisplayMessagesFor,
  sendMessage,
} from '../../features/chats'
import { readServerLoopRejection } from '../../features/chats/chatActions'
import { selectChatErrorsForConversation } from '../../features/chats/chatSelectors'
import type { PlanClarificationAnswer } from '../../features/chats/planToolTypes'
import { generateStreamId } from '../../features/chats/streamHelpers'
import { useAppDispatch, useAppSelector } from '../../hooks/redux'
import { useSelectedModel } from '../../hooks/useQueries'
import { Button } from '../Button/button'
import { ChatErrorBubble } from '../ChatErrorBubble/ChatErrorBubble'
import { ChatMessage } from '../ChatMessage/ChatMessage'
import { ChatComposerFrame } from '../ChatPane/ChatComposerFrame'
import {
  ChatInputController,
  type ChatInputControllerHandle,
  type ChatInputUpdater,
} from '../ChatPane/ChatInputController'
import { ChatPaneSurface } from '../ChatPane/ChatPaneSurface'
import { ChatPaneToolbar } from '../ChatPane/ChatPaneToolbar'
import { advancePanePath, selectErrorsForPane } from '../ChatPane/paneState'
import { PlanClarificationPanel } from '../PlanClarificationPanel/PlanClarificationPanel'
import { ReasoningLevelControl } from '../ReasoningLevelControl/ReasoningLevelControl'
import {
  getStoredSendButtonAnimation,
  getStoredSendButtonDarkColor,
  getStoredSendButtonLightColor,
} from '../SettingsPane/SendButtonAnimationSettings'
import { StreamingThinkingIndicator } from '../StreamingThinkingIndicator/StreamingThinkingIndicator'
import { ToolPermissionDialog } from '../ToolPermissionDialog/ToolPermissionDialog'
import {
  getThemeModeColor,
  useCustomChatTheme,
  useHtmlDarkMode,
} from '../ThemeManager/themeConfig'

export interface ParallelChatPaneTarget {
  conversationId: ConversationId
  messageId: MessageId
  path: MessageId[]
  lineageId?: LineageId | null
}

interface ParallelChatPaneProps {
  target: ParallelChatPaneTarget
  onClose: () => void
  onActivate?: () => void
  active?: boolean
  title?: string
  fontSizeOffset?: number
  groupToolReasoningRuns?: boolean
  truncateToolOutput?: boolean
  onOpenToolHtmlModal?: (key?: string) => void
  onOpenSubagentTranscript?: (toolCallId: string) => void
  onOpenSettings?: () => void
  onChatErrorAction?: (record: ChatErrorRecord, kind: ChatErrorActionKind) => void
  width?: string
  onEditMessage?: (id: string, content: string) => void
  onDeleteMessage?: (id: string) => void
  onAddToNote?: (text: string) => void
}

const parseToolCalls = (value: unknown): ToolCall[] | undefined => {
  if (!value) return undefined
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value
    return Array.isArray(parsed) ? parsed : [parsed]
  } catch {
    return undefined
  }
}

/**
 * A second controller over the same canonical conversation. Branch identity, draft, optimistic
 * turn, stream fallback, scroll following, reasoning choice and decisions are pane-local.
 */
export function ParallelChatPane({
  target,
  onClose,
  onActivate,
  active = false,
  title = 'Parallel branch',
  fontSizeOffset = 0,
  groupToolReasoningRuns = false,
  truncateToolOutput = true,
  onOpenToolHtmlModal,
  onOpenSubagentTranscript,
  onOpenSettings,
  onChatErrorAction,
  width,
  onEditMessage,
  onDeleteMessage,
  onAddToNote,
}: ParallelChatPaneProps) {
  const dispatch = useAppDispatch()
  const inputControllerRef = useRef<ChatInputControllerHandle | null>(null)
  const transcriptRef = useRef<HTMLDivElement | null>(null)
  const bottomRef = useRef<HTMLDivElement | null>(null)
  const userScrolledRef = useRef(false)
  const targetGenerationRef = useRef(0)

  const messages = useAppSelector(state => state.chat.conversation.messages)
  const streaming = useAppSelector(state => state.chat.streaming)
  const providers = useAppSelector(state => state.chat.providerState)
  const operationMode = useAppSelector(state => state.chat.operationMode)
  const toolAutoApprove = useAppSelector(state => state.chat.toolAutoApprove)
  const errors = useAppSelector(state => selectChatErrorsForConversation(state, target.conversationId))
  const selectedModel = useSelectedModel(providers.currentProvider)
  const { theme: customTheme, enabled: customThemeEnabled } = useCustomChatTheme()
  const isDarkMode = useHtmlDarkMode()

  const [path, setPath] = useState<MessageId[]>(target.path)
  const [lineageId, setLineageId] = useState<LineageId | null>(target.lineageId ?? null)
  const [hasDraft, setHasDraft] = useState(false)
  const [pendingStreamId, setPendingStreamId] = useState<string | null>(null)
  const [optimisticMessage, setOptimisticMessage] = useState<{
    id: string
    content: string
    createdAt: string
    parentId: MessageId | null
  } | null>(null)
  const [think, setThink] = useState(false)
  const [reasoningConfig, setReasoningConfig] = useState<ReasoningConfig>({ effort: 'medium' })

  useEffect(() => {
    targetGenerationRef.current += 1
    setPath(target.path)
    setLineageId(target.lineageId ?? null)
    setPendingStreamId(null)
    setOptimisticMessage(null)
    userScrolledRef.current = false
  }, [target.conversationId, target.messageId, target.path, target.lineageId])

  const displayMessages = useMemo(() => selectDisplayMessagesFor(messages, path), [messages, path])
  const selectedStream = useMemo(
    () =>
      selectCurrentViewStreamFor(streaming, {
        conversationId: String(target.conversationId),
        lineageId: lineageId == null ? null : String(lineageId),
        path,
      }),
    [lineageId, path, streaming, target.conversationId]
  )
  const pendingStream = pendingStreamId && streaming.byId[pendingStreamId]
    ? { id: pendingStreamId, ...streaming.byId[pendingStreamId] }
    : null
  // The stream this pane explicitly started is authoritative until it ends. A sibling stream
  // with similar lineage/path anchors must never steal this pane's Stop or decision controls.
  const effectiveStream = pendingStream?.active ? pendingStream : selectedStream ?? pendingStream
  const streamId = effectiveStream?.id ?? pendingStreamId
  const streamActive = Boolean(effectiveStream?.active)
  const canSend = hasDraft && !streamActive

  const permissionRequest = useAppSelector(state =>
    streamId ? (state.chat.toolPermissionRequestsByStream[streamId] ?? null) : null
  )
  const operationModeUpgradeRequest = useAppSelector(state =>
    streamId ? (state.chat.operationModeUpgradeRequestsByStream[streamId] ?? null) : null
  )
  const clarificationRequest = useAppSelector(state =>
    streamId ? (state.chat.planClarificationRequestsByStream[streamId] ?? null) : null
  )

  const paneErrors = useMemo(
    () =>
      selectErrorsForPane(errors, {
        conversationId: String(target.conversationId),
        lineageId,
        path,
        streamId: streamId ?? null,
      }),
    [errors, lineageId, path, streamId, target.conversationId]
  )

  const surfaceColor = customThemeEnabled
    ? getThemeModeColor(customTheme.colors.chatPanelBg, isDarkMode)
    : isDarkMode
      ? 'oklch(20.5% 0 0)'
      : 'oklch(98.5% 0 0)'
  const toolbarColor = customThemeEnabled
    ? getThemeModeColor(customTheme.colors.conversationToolbarBg, isDarkMode)
    : isDarkMode
      ? 'rgba(23, 23, 23, 0.8)'
      : 'rgba(255, 255, 255, 0.8)'
  const sendButtonColor = customThemeEnabled
    ? getThemeModeColor(customTheme.colors.sendButtonAnimationColor, isDarkMode)
    : isDarkMode
      ? getStoredSendButtonDarkColor()
      : getStoredSendButtonLightColor()

  const updateDraft = useCallback((next: ChatInputUpdater) => inputControllerRef.current?.setValue(next), [])

  const handleSend = useCallback(() => {
    const rawContent = inputControllerRef.current?.getValue() ?? ''
    const content = rawContent.trim()
    if (!content || streamActive) return

    const parent = path[path.length - 1] ?? target.messageId
    const sendGeneration = targetGenerationRef.current
    const nextStreamId = generateStreamId('branch')
    setPendingStreamId(nextStreamId)
    setOptimisticMessage({
      id: `parallel-temp-${Date.now()}`,
      content,
      createdAt: new Date().toISOString(),
      parentId: parent ?? null,
    })
    inputControllerRef.current?.clear()

    void dispatch(
      sendMessage({
        conversationId: target.conversationId,
        input: { content },
        parent,
        repeatNum: 1,
        think,
        reasoningConfig: think ? reasoningConfig : undefined,
        operationMode,
        streamId: nextStreamId,
        lineageId,
        branchPath: path,
        streamType: 'branch',
        updatePath: false,
        includeGlobalComposerContext: false,
      })
    )
      .unwrap()
      .then(result => {
        if (targetGenerationRef.current !== sendGeneration) return
        const finalMessageId = result.messageId
        const userMessageId = result.userMessage?.id as MessageId | undefined
        setPath(previous => advancePanePath(messages, previous, userMessageId, finalMessageId))
        setOptimisticMessage(null)
      })
      .catch(error => {
        if (targetGenerationRef.current !== sendGeneration) return
        const rejection = readServerLoopRejection(error)
        if (!rejection || rejection.envelope.code !== 'cancelled') {
          updateDraft(previous => (previous.trim() ? `${content}\n\n${previous}` : content))
        }
        setOptimisticMessage(null)
      })
      .finally(() => {
        if (targetGenerationRef.current === sendGeneration) setPendingStreamId(null)
      })
  }, [dispatch, lineageId, messages, operationMode, path, reasoningConfig, streamActive, target.conversationId, target.messageId, think, updateDraft])

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    userScrolledRef.current = false
    bottomRef.current?.scrollIntoView({ block: 'end', behavior })
  }, [])

  useEffect(() => {
    if (!streamActive || userScrolledRef.current) return
    const frame = requestAnimationFrame(() => scrollToBottom('auto'))
    return () => cancelAnimationFrame(frame)
  }, [effectiveStream?.buffer, effectiveStream?.events?.length, scrollToBottom, streamActive])

  const dismissError = useCallback(
    (record: ChatErrorRecord) => {
      dispatch(chatSliceActions.chatErrorDismissed({ conversationId: record.conversationId, id: record.id }))
    },
    [dispatch]
  )

  const renderComposer = (
    <ChatComposerFrame
      canSend={canSend}
      streaming={streamActive}
      onSend={handleSend}
      onStop={() => {
        if (effectiveStream?.id) void dispatch(abortGeneration({ streamId: effectiveStream.id }))
      }}
      sendButtonAnimation={getStoredSendButtonAnimation()}
      sendButtonColor={sendButtonColor}
      controlsLeft={
        <div className='flex min-w-0 flex-1 items-center gap-1'>
          <button
            type='button'
            className='flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/80 text-stone-700 backdrop-blur-xl transition-[background-color,color,transform] duration-200 hover:-translate-y-0.5 hover:scale-105 hover:bg-white hover:text-stone-950 active:translate-y-0 active:scale-95 dark:bg-yBlack-900/80 dark:text-stone-200 dark:hover:bg-neutral-900 dark:hover:text-white'
            onClick={onOpenSettings}
            disabled={!onOpenSettings}
            title='Chat Settings'
            aria-label='Chat Settings'
          >
            <Settings className='h-5 w-5' strokeWidth={2.25} aria-hidden='true' />
          </button>
          <span className='min-w-0 truncate px-2 text-xs text-neutral-500 dark:text-neutral-400'>
            {providers.currentProvider || 'Provider'} · {selectedModel?.name || 'Select model'}
          </span>
        </div>
      }
      controlsRight={
        <ReasoningLevelControl
          supported={Boolean(selectedModel?.thinking)}
          level={think ? reasoningConfig.effort : 'off'}
          onLevelChange={level => {
            if (level === 'off') {
              setThink(false)
              return
            }
            setThink(true)
            setReasoningConfig(previous => ({ ...previous, effort: level }))
          }}
        />
      }
    >
      {operationModeUpgradeRequest && (
        <ToolPermissionDialog
          toolCall={operationModeUpgradeRequest.toolCall}
          variant='operation-mode-upgrade'
          onGrant={() =>
            dispatch(
              respondToOperationModeUpgrade({ approved: true, streamId: operationModeUpgradeRequest.streamId })
            )
          }
          onDeny={() =>
            dispatch(
              respondToOperationModeUpgrade({ approved: false, streamId: operationModeUpgradeRequest.streamId })
            )
          }
        />
      )}
      {!operationModeUpgradeRequest && permissionRequest && (
        <ToolPermissionDialog
          toolCall={permissionRequest.toolCall}
          onGrant={() => dispatch(respondToToolPermission({ allowed: true, streamId: permissionRequest.streamId }))}
          onDeny={() => dispatch(respondToToolPermission({ allowed: false, streamId: permissionRequest.streamId }))}
          onAllowAll={() => dispatch(respondToToolPermissionAndEnableAll(permissionRequest.streamId))}
        />
      )}
      {clarificationRequest && (
        <PlanClarificationPanel
          request={clarificationRequest}
          onSubmit={(answers: PlanClarificationAnswer[]) =>
            dispatch(respondToPlanClarification({ answers, streamId: clarificationRequest.streamId }))
          }
          onCancel={() => dispatch(cancelPlanClarification(clarificationRequest.streamId))}
        />
      )}
      <ChatInputController
        ref={inputControllerRef}
        conversationId={target.conversationId}
        initialValue=''
        onHasTextChange={setHasDraft}
        onSubmit={handleSend}
        onBlurPersist={() => undefined}
        fallbackFileSearchRoot={null}
        filterSelectedMentionFiles={false}
        enableImageAttachments={false}
        enableFileMentions={false}
        imageDraftTarget={{ kind: 'composer' }}
        fontSizeOffset={fontSizeOffset}
        autoFocus={false}
      />
    </ChatComposerFrame>
  )

  return (
    <ChatPaneSurface
      active={active}
      onActivate={onActivate}
      surfaceColor={surfaceColor}
      className={width ? 'flex-none' : ''}
      style={width ? { width } : undefined}
      ariaLabel='Parallel conversation branch'
      transcriptRef={transcriptRef}
      onTranscriptScroll={event => {
        if (!streamActive) return
        const element = event.currentTarget
        const remaining = element.scrollHeight - element.scrollTop - element.clientHeight
        if (remaining > 140) userScrolledRef.current = true
      }}
      toolbar={
        <ChatPaneToolbar
          title={title}
          subtitle={toolAutoApprove ? 'Agent · Allow all' : operationMode === 'plan' ? 'Chat · Ask' : 'Agent · Ask'}
          backgroundColor={toolbarColor}
          darkMode={isDarkMode}
          onClose={onClose}
        />
      }
      composer={renderComposer}
    >
      <div className='flex shrink-0 flex-col px-0 pb-4'>
        {displayMessages.map(message => (
          <ChatMessage
            key={`parallel-${message.id}`}
            id={`parallel-${message.id}`}
            role={message.role}
            content={message.content}
            thinking={message.thinking_block}
            toolCalls={parseToolCalls(message.tool_calls)}
            contentBlocks={message.content_blocks}
            timestamp={message.created_at}
            modelName={message.model_name}
            artifacts={message.artifacts}
            width='w-full'
            fontSizeOffset={fontSizeOffset}
            groupToolReasoningRuns={groupToolReasoningRuns}
            truncateToolOutput={truncateToolOutput}
            customTheme={customTheme}
            customThemeEnabled={customThemeEnabled}
            isDarkMode={isDarkMode}
            onEdit={
              onEditMessage ? (_id, content) => onEditMessage(String(message.id), content) : undefined
            }
            onDelete={onDeleteMessage ? () => onDeleteMessage(String(message.id)) : undefined}
            onAddToNote={onAddToNote}
            onOpenToolHtmlModal={onOpenToolHtmlModal}
            onOpenSubagentTranscript={onOpenSubagentTranscript}
          />
        ))}
        {optimisticMessage && (
          <ChatMessage
            id={optimisticMessage.id}
            role='user'
            content={optimisticMessage.content}
            timestamp={optimisticMessage.createdAt}
            modelName={selectedModel?.name}
            width='w-full'
            fontSizeOffset={fontSizeOffset}
            groupToolReasoningRuns={groupToolReasoningRuns}
            truncateToolOutput={truncateToolOutput}
            customTheme={customTheme}
            customThemeEnabled={customThemeEnabled}
            isDarkMode={isDarkMode}
            className='opacity-70'
          />
        )}
        {streamActive && effectiveStream && (
          <ChatMessage
            id={`parallel-streaming-${effectiveStream.id}`}
            role='assistant'
            content={effectiveStream.buffer}
            thinking={effectiveStream.thinkingBuffer}
            toolCalls={effectiveStream.toolCalls}
            streamEvents={effectiveStream.events}
            width='w-full'
            fontSizeOffset={fontSizeOffset}
            groupToolReasoningRuns={groupToolReasoningRuns}
            truncateToolOutput={truncateToolOutput}
            customTheme={customTheme}
            customThemeEnabled={customThemeEnabled}
            isDarkMode={isDarkMode}
            modelName={selectedModel?.name}
            onOpenToolHtmlModal={onOpenToolHtmlModal}
            onOpenSubagentTranscript={onOpenSubagentTranscript}
          />
        )}
        {streamActive && effectiveStream && !effectiveStream.buffer && effectiveStream.events.length === 0 && (
          <div className='px-2 pt-1'>
            <StreamingThinkingIndicator />
          </div>
        )}
        {paneErrors.map(record => (
          <div key={record.id} className='px-2 pt-2'>
            <ChatErrorBubble
              envelope={record.envelope}
              onAction={kind => {
                if (kind === 'retry') {
                  const failedText = optimisticMessage?.content
                  if (failedText) updateDraft(failedText)
                  dismissError(record)
                  inputControllerRef.current?.focus()
                  return
                }
                onChatErrorAction?.(record, kind)
              }}
              onDismiss={() => dismissError(record)}
            />
          </div>
        ))}
        <div ref={bottomRef} aria-hidden='true' className='h-[420px] shrink-0' />
      </div>
      {displayMessages.length > 0 && (
        <Button
          variant='outline2'
          size='small'
          className='absolute bottom-44 right-5 z-40 !rounded-full !p-2 backdrop-blur-xl'
          onClick={() => scrollToBottom()}
          aria-label='Scroll to latest'
          title='Scroll to latest'
        >
          <ChevronDown className='h-4 w-4' aria-hidden='true' />
        </Button>
      )}
    </ChatPaneSurface>
  )
}
