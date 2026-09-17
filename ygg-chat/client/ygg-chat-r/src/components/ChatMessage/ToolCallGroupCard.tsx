import React from 'react'
import { AppWindow, ExternalLink, Loader2, Maximize2, MessagesSquare, Play } from 'lucide-react'
import type { ToolDefinition } from '@/features/chats/toolDefinitions'
import { truncateToolOutput as truncateToolOutputPreview } from '../../helpers/toolOutputTruncation'
import { EditToolDiffView } from '../EditFileDiffView/EditToolDiffView'
import { PlanMdToolView } from '../PlanMdToolView'
import { McpAppIframe } from '../McpAppIframe/McpAppIframe'
import { SubagentToolName } from '../SubagentTranscript/SubagentTranscript'
import { HtmlIframe } from './HtmlIframe'
import {
  ACTION_PILL_CLASS,
  DISCLOSURE_BODY_CLASS,
  DISCLOSURE_LABEL_CLASS,
  extractHtmlFromToolResult,
  formatToolResultSummary,
  MESSAGE_BLOCK_INSET_CLASS,
  MONO_DETAIL_CLASS,
  MONO_KEY_CLASS,
  parseMcpQualifiedName,
  stringifyToolValue,
  SURFACE_CARD_CLASS,
  TOOL_NAME_ERROR_CLASS,
  TOOL_NAME_RUNNING_CLASS,
  TOOL_NAME_SUCCESS_CLASS,
  type ToolCallRenderGroup,
} from './chatMessageShared'
import {
  Badge,
  DisclosurePanel,
  DisclosureRow,
  FieldRows,
  SectionLabel,
  SurfaceCard,
  type BadgeTone,
  type DisclosureTone,
} from './messagePrimitives'

export interface McpViewerPayload {
  serverName: string
  resourceUri: string
  qualifiedToolName: string
  toolArgs?: Record<string, any> | null
  toolResult?: { content: any; is_error?: boolean } | null
  toolDefinition?: ToolDefinition
  reloadToken?: number
}

export interface ToolCallGroupCardProps {
  group: ToolCallRenderGroup
  /** Stable key for expansion state, `tool-group-${key}`. */
  toggleKey: string
  messageId: string
  expanded: boolean
  onToggle: () => void
  disableExpandTransition?: boolean
  onExpandTransitionEnd?: () => void
  contentStyle?: React.CSSProperties
  truncateToolOutput: boolean
  toolDefinitions: ToolDefinition[]
  mcpLoadState: Record<string, boolean>
  mcpReloadTokens: Record<string, number>
  onLoadMcpApp: (serverName: string, reloadKey: string) => void
  canOpenViewer: boolean
  onOpenHtmlViewer: (entryKey: string) => void
  onOpenMcpViewer: (entryKey: string, payload: McpViewerPayload, label?: string | null) => void
  onOpenSubagentTranscript?: (toolCallId: string) => void
  onNavigate: (route: string) => void
}

/** Tool names vary by provider in case and separator, so compare on a normalized form. */
const normalizeToolName = (name: unknown): string =>
  String(name ?? '')
    .toLowerCase()
    .replace(/[-\s]/g, '_')

const STATIC_ROW_CLASS = `flex h-8 min-w-0 w-full items-center gap-2 ${MESSAGE_BLOCK_INSET_CLASS}`

const extractPathParam = (args: any): string | null => {
  if (!args || typeof args !== 'object') return null

  if (Array.isArray(args.edits)) {
    const editPaths = args.edits
      .map((edit: any) => (edit && typeof edit === 'object' && typeof edit.path === 'string' ? edit.path : null))
      .filter((value: string | null): value is string => Boolean(value))

    if (editPaths.length > 0) {
      return editPaths.length === 1 ? editPaths[0] : `${editPaths[0]} +${editPaths.length - 1} more`
    }
    if (args.edits.length > 0) {
      return `${args.edits.length} edits`
    }
  }

  const pathKeys = ['file_path', 'path', 'directory', 'dir', 'output_path', 'input_path', 'filepath']
  for (const key of pathKeys) {
    if (args[key] && typeof args[key] === 'string') {
      return args[key]
    }
  }
  return null
}

const parseToolJsonObject = (value: unknown): Record<string, any> | null => {
  if (!value) return null
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, any>
  if (typeof value !== 'string') return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, any>) : null
  } catch {
    return null
  }
}

const getToolPayloadStatus = (
  payload: Record<string, any> | null,
  fallbackIsError?: boolean
): { label: string; tone: BadgeTone } | null => {
  if (fallbackIsError) return { label: 'failed', tone: 'error' }
  if (!payload) return fallbackIsError === false ? { label: 'ok', tone: 'success' } : null
  if (typeof payload.ok === 'boolean') return { label: payload.ok ? 'ok' : 'failed', tone: payload.ok ? 'success' : 'error' }
  if (typeof payload.success === 'boolean') {
    return { label: payload.success ? 'success' : 'failure', tone: payload.success ? 'success' : 'error' }
  }
  if (typeof payload.isError === 'boolean') {
    return { label: payload.isError ? 'failed' : 'ok', tone: payload.isError ? 'error' : 'success' }
  }
  return fallbackIsError === false ? { label: 'ok', tone: 'success' } : null
}

const toneForGroup = (hasResults: boolean, hasError: boolean): DisclosureTone =>
  hasError ? 'error' : hasResults ? 'success' : 'running'

const toolNameClassForTone = (tone: DisclosureTone): string =>
  tone === 'error' ? TOOL_NAME_ERROR_CLASS : tone === 'running' ? TOOL_NAME_RUNNING_CLASS : TOOL_NAME_SUCCESS_CLASS

const ToolName: React.FC<{ name: string; tone: DisclosureTone }> = ({ name, tone }) => (
  <span className={`${DISCLOSURE_LABEL_CLASS} ${toolNameClassForTone(tone)}`}>{name}</span>
)

/**
 * One tool call with its results. Every variant shares the same 32px header row and the
 * same inset so tool cards line up with reasoning rows and prose in the block stack.
 */
export const ToolCallGroupCard: React.FC<ToolCallGroupCardProps> = ({
  group,
  toggleKey,
  messageId,
  expanded,
  onToggle,
  disableExpandTransition,
  onExpandTransitionEnd,
  contentStyle,
  truncateToolOutput,
  toolDefinitions,
  mcpLoadState,
  mcpReloadTokens,
  onLoadMcpApp,
  canOpenViewer,
  onOpenHtmlViewer,
  onOpenMcpViewer,
  onOpenSubagentTranscript,
  onNavigate,
}) => {
  // Orphaned results waiting for their tool_call never draw.
  if (group.anchorIndex === -1) return null

  const rawName = group.name ?? ''
  const normalizedName = normalizeToolName(rawName)
  const isMcpGroup = rawName.startsWith('mcp__')
  const parsedMcp = isMcpGroup ? parseMcpQualifiedName(rawName) : null
  const mcpServerName = parsedMcp?.serverName
  const hasResults = group.results.length > 0
  const resultSummary = hasResults ? formatToolResultSummary(group.results[0].content) : null
  const hasError = group.results.some(r => r.is_error) || resultSummary === 'failure'
  const tone = toneForGroup(hasResults, hasError)
  const panelId = `${toggleKey}-panel`

  const viewerPill = (entryKey: string) => (
    <button
      type='button'
      onClick={() => onOpenHtmlViewer(entryKey)}
      disabled={!canOpenViewer}
      className={ACTION_PILL_CLASS}
      title='Open tool output viewer'
      aria-label='Open tool output viewer'
    >
      <AppWindow size={13} strokeWidth={2.25} aria-hidden='true' />
      Viewer
    </button>
  )

  const loadAppPill = (serverName: string, reloadKey: string) => (
    <button
      type='button'
      onClick={() => onLoadMcpApp(serverName, reloadKey)}
      disabled={mcpLoadState[reloadKey]}
      className={ACTION_PILL_CLASS}
      title='Start the MCP server and reload the app'
      aria-label='Load app'
    >
      {mcpLoadState[reloadKey] ? (
        <Loader2 size={13} strokeWidth={2.25} className='animate-spin motion-reduce:animate-none' aria-hidden='true' />
      ) : (
        <Play size={13} strokeWidth={2.25} aria-hidden='true' />
      )}
      Load app
    </button>
  )

  const wrapperStyle = contentStyle

  // html_renderer: the input HTML is the artifact. Always visible.
  const isHtmlRenderer = normalizedName === 'html_renderer'
  if (isHtmlRenderer && group.args && typeof group.args.html === 'string') {
    const htmlPreviewKey = `${messageId}-html-renderer-${group.id}`
    return (
      <div className='min-w-0 max-w-full' style={wrapperStyle} data-chat-block='tool'>
        <div className={STATIC_ROW_CLASS}>
          <ToolName name={rawName || 'html_renderer'} tone={hasResults ? 'success' : 'running'} />
          <span className='min-w-0 flex-1' />
          {viewerPill(htmlPreviewKey)}
        </div>
        <div className={DISCLOSURE_BODY_CLASS}>
          <div className={`${SURFACE_CARD_CLASS} p-1`}>
            <HtmlIframe html={group.args.html} toolName={rawName || null} />
          </div>
        </div>
      </div>
    )
  }

  // internalLink: a navigation affordance plus the resolved target.
  if (normalizedName === 'internallink' || normalizedName === 'internal_link') {
    const resultPayload = hasResults ? group.results[group.results.length - 1].content : null
    const parsedPayload = parseToolJsonObject(resultPayload)
    const target = parsedPayload?.target && typeof parsedPayload.target === 'object' ? parsedPayload.target : null
    const route: string | null = typeof target?.route === 'string' ? target.route : null
    const routeType: string = typeof target?.routeType === 'string' ? target.routeType : 'conversation'
    const nonEmpty = (value: unknown): string | null =>
      typeof value === 'string' && value.trim().length > 0 ? value : null
    const conversationIdLabel = nonEmpty(target?.conversationId)
    const projectIdLabel = nonEmpty(target?.projectId)
    const messageIdLabel = nonEmpty(target?.messageId)
    const providedLabel = typeof parsedPayload?.label === 'string' ? parsedPayload.label.trim() : ''
    const conversationTitle = nonEmpty(target?.conversationTitle)
    const buttonLabel =
      providedLabel ||
      conversationTitle ||
      (routeType === 'project'
        ? projectIdLabel
          ? `Open project ${projectIdLabel}`
          : 'Open project'
        : conversationIdLabel
          ? `Open chat ${conversationIdLabel}`
          : 'Open chat')
    const warnings: string[] = Array.isArray(parsedPayload?.warnings)
      ? parsedPayload.warnings.filter((value: unknown): value is string => typeof value === 'string' && value.trim().length > 0)
      : []
    const errorText = typeof parsedPayload?.error === 'string' ? parsedPayload.error : null
    const linkFailed = parsedPayload?.success === false || !route
    const fields: Record<string, unknown> = {}
    if (projectIdLabel) fields.projectId = projectIdLabel
    if (conversationIdLabel) fields.conversationId = conversationIdLabel
    if (messageIdLabel) fields.messageId = messageIdLabel
    if (route) fields.route = route

    return (
      <div className='min-w-0 max-w-full' style={wrapperStyle} data-chat-block='tool'>
        <div className={STATIC_ROW_CLASS}>
          <ToolName name={rawName || 'internalLink'} tone={linkFailed ? 'error' : 'success'} />
          <span className='min-w-0 flex-1' />
          <button
            type='button'
            onClick={() => route && onNavigate(route)}
            disabled={!route}
            className={ACTION_PILL_CLASS}
            title={route ? `Navigate to ${route}` : 'No route resolved'}
          >
            <ExternalLink size={13} strokeWidth={2.25} aria-hidden='true' />
            <span className='max-w-[240px] truncate'>{buttonLabel}</span>
          </button>
        </div>
        <div className={`${DISCLOSURE_BODY_CLASS} space-y-1`}>
          <FieldRows record={Object.keys(fields).length > 0 ? fields : null} fallback={{ key: 'route', value: route }} />
          {!route && errorText && (
            <div className={`${MONO_DETAIL_CLASS} text-red-600 dark:text-red-400`}>
              <span className={MONO_KEY_CLASS}>error:</span> {errorText}
            </div>
          )}
          {warnings.length > 0 && (
            <div className={`${MONO_DETAIL_CLASS} text-amber-700 dark:text-amber-400`}>{warnings.join(' • ')}</div>
          )}
        </div>
      </div>
    )
  }

  // MCP app with a UI resource: the app is the artifact. Always visible.
  const mcpTool = toolDefinitions.find(t => t.isMcp && t.name === rawName)
  const mcpResourceUri = mcpTool?.mcpUi?.resourceUri
  if (mcpTool && mcpResourceUri) {
    const serverName = mcpTool.mcpServerName || parsedMcp?.serverName
    if (serverName) {
      const latestResult = hasResults ? group.results[group.results.length - 1] : null
      const normalizedResult = latestResult ? { content: latestResult.content, is_error: latestResult.is_error } : null
      const reloadKey = `${messageId}-${group.id}-mcp`
      const mcpEntryKey = `${messageId}-${group.id}-mcp-app`
      const rawLabel = mcpTool.mcpToolName || parsedMcp?.toolName || rawName || 'MCP App'
      const mcpLabel = rawLabel.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
      const payload: McpViewerPayload = {
        serverName,
        resourceUri: mcpResourceUri,
        qualifiedToolName: mcpTool.name,
        toolArgs: group.args || undefined,
        toolResult: normalizedResult,
        toolDefinition: mcpTool,
        reloadToken: mcpReloadTokens[reloadKey] || 0,
      }
      return (
        <div className='min-w-0 max-w-full' style={wrapperStyle} data-chat-block='tool'>
          <div className={STATIC_ROW_CLASS}>
            <ToolName name={rawName || 'mcp_app'} tone={latestResult?.is_error ? 'error' : latestResult ? 'success' : 'running'} />
            <Badge tone='success'>MCP App</Badge>
            <span className='min-w-0 flex-1' />
            <button
              type='button'
              onClick={() => onOpenMcpViewer(mcpEntryKey, payload, mcpLabel)}
              disabled={!canOpenViewer}
              className={ACTION_PILL_CLASS}
              title='Open MCP app viewer'
              aria-label='Open MCP app viewer'
            >
              <Maximize2 size={13} strokeWidth={2.25} aria-hidden='true' />
              Fullscreen
            </button>
            {loadAppPill(serverName, reloadKey)}
          </div>
          <div className={DISCLOSURE_BODY_CLASS}>
            <div className={`${SURFACE_CARD_CLASS} p-1`}>
              <McpAppIframe
                serverName={serverName}
                qualifiedToolName={mcpTool.name}
                resourceUri={mcpResourceUri}
                toolArgs={group.args || undefined}
                toolResult={normalizedResult}
                toolDefinition={mcpTool}
                reloadToken={mcpReloadTokens[reloadKey] || 0}
                heightKey={mcpEntryKey}
                className='w-full rounded-xl bg-white'
              />
            </div>
          </div>
        </div>
      )
    }
  }

  // plan_md display: the plan view is the artifact.
  if (normalizedName === 'plan_md' && String(group.args?.action || '').toLowerCase() === 'display' && group.args) {
    const planResult = hasResults ? group.results[0].content : {}
    return (
      <div className='min-w-0 max-w-full' style={wrapperStyle} data-chat-block='tool'>
        <div className={STATIC_ROW_CLASS}>
          <ToolName name={rawName || 'plan_md'} tone={tone} />
        </div>
        <div className={DISCLOSURE_BODY_CLASS}>
          <PlanMdToolView args={group.args} result={planResult} />
        </div>
      </div>
    )
  }

  // Edit tools: the diff summary is the body.
  const isEditLikeTool =
    normalizedName === 'edit_file' || normalizedName === 'editfile' || normalizedName === 'multi_edit'
  if (isEditLikeTool && group.args) {
    const editResult = hasResults ? group.results[0].content : {}
    const editTone: DisclosureTone = !hasResults
      ? 'running'
      : formatToolResultSummary(editResult) === 'success'
        ? 'success'
        : 'error'
    return (
      <div className='min-w-0 max-w-full' style={wrapperStyle} data-chat-block='tool'>
        <div className={STATIC_ROW_CLASS}>
          <ToolName name={rawName || 'edit_file'} tone={editTone} />
        </div>
        <div className={DISCLOSURE_BODY_CLASS}>
          <EditToolDiffView toolName={group.name} args={group.args} result={editResult} className='min-w-0' />
        </div>
      </div>
    )
  }

  // Generic tool: collapsible row, inputs and outputs inside.
  const isSubagent = normalizedName === 'subagent' || normalizedName === 'subagent_manager'
  const isSubagentSpawn =
    normalizedName === 'subagent' ||
    (normalizedName === 'subagent_manager' && String(group.args?.action ?? '').toLowerCase() === 'spawn')
  const pathContent = extractPathParam(group.args)
  const htmlResultKeys = group.results
    .map((result, resultIdx) =>
      extractHtmlFromToolResult(result.content)?.html ? `${messageId}-${group.id}-result-${resultIdx}` : null
    )
    .filter((key): key is string => Boolean(key))
  const primaryHtmlResultKey = htmlResultKeys[0]
  const hasHtmlOutput = htmlResultKeys.length > 0

  const getGenericToolOutputPreview = (value: unknown) => {
    const text = stringifyToolValue(value)
    return truncateToolOutput ? truncateToolOutputPreview(text) : { text, truncated: false, omittedCharacters: 0 }
  }

  const label = isSubagent ? (
    <SubagentToolName toolCallId={group.id} name={rawName || 'tool'} fallbackClass={toolNameClassForTone(tone)} />
  ) : (
    rawName || 'tool'
  )

  const transcriptPill = (toolCallId: string, label = 'Transcript') => (
    <button
      type='button'
      onClick={() => onOpenSubagentTranscript?.(toolCallId)}
      disabled={!onOpenSubagentTranscript}
      className={ACTION_PILL_CLASS}
      title='View subagent transcript'
      aria-label='View subagent transcript'
    >
      <MessagesSquare size={13} strokeWidth={2.25} aria-hidden='true' />
      {label}
    </button>
  )

  /**
   * Subagents spawned through `multi_call` never carry the group's own tool name, so the
   * ordinary `isSubagent` branch cannot see them. The server gives each nested call the
   * synthetic id `${parentId}:${1-based index}` (multiCallExecutor.ts) and the subagent run
   * is persisted under exactly that id, so the transcript is reachable by rebuilding it here.
   */
  const nestedSubagentCalls: Array<{ index: number; toolCallId: string }> =
    normalizedName === 'multi_call' && Array.isArray(group.args?.calls)
      ? (group.args.calls as any[])
          .map((call, index) => {
            const record = call && typeof call === 'object' ? (call as Record<string, any>) : null
            const nestedName = normalizeToolName(
              typeof record?.tool === 'string' ? record.tool : typeof record?.toolName === 'string' ? record.toolName : ''
            )
            const nestedAction = String((record?.args as Record<string, any> | undefined)?.action ?? '').toLowerCase()
            const isNestedSubagentSpawn =
              nestedName === 'subagent' || (nestedName === 'subagent_manager' && nestedAction === 'spawn')
            return isNestedSubagentSpawn ? { index, toolCallId: `${group.id}:${index + 1}` } : null
          })
          .filter((entry): entry is { index: number; toolCallId: string } => entry !== null)
      : []

  // A fan-out of several subagents would crowd the header, so only the single case gets a
  // header pill. Every nested run is always reachable from its card in the expanded input.
  const soleNestedSubagent = nestedSubagentCalls.length === 1 ? nestedSubagentCalls[0] : null

  const trailing = (
    <>
      {isMcpGroup && mcpServerName && loadAppPill(mcpServerName, `${messageId}-${group.id}-mcp`)}
      {primaryHtmlResultKey && viewerPill(primaryHtmlResultKey)}
      {isSubagentSpawn && transcriptPill(group.id)}
      {soleNestedSubagent && transcriptPill(soleNestedSubagent.toolCallId)}
    </>
  )
  const hasTrailing = Boolean(
    (isMcpGroup && mcpServerName) || primaryHtmlResultKey || isSubagentSpawn || soleNestedSubagent
  )

  const renderInputs = () => {
    if (hasHtmlOutput || !group.args || Object.keys(group.args).length === 0) return null

    if (normalizedName === 'multi_call' && Array.isArray(group.args.calls)) {
      const calls: any[] = group.args.calls
      return (
        <div className='min-w-0 max-w-full'>
          <SectionLabel label='input'>
            <Badge>{`${calls.length} call${calls.length === 1 ? '' : 's'}`}</Badge>
            {typeof group.args.parallel !== 'undefined' && <Badge tone='info'>{`parallel: ${String(group.args.parallel)}`}</Badge>}
            {typeof group.args.stopOnError !== 'undefined' && (
              <Badge tone='warning'>{`stopOnError: ${String(group.args.stopOnError)}`}</Badge>
            )}
          </SectionLabel>
          <div className='space-y-1.5'>
            {calls.map((call, callIdx) => {
              const callRecord = call && typeof call === 'object' ? (call as Record<string, any>) : null
              const toolName =
                typeof callRecord?.tool === 'string'
                  ? callRecord.tool
                  : typeof callRecord?.toolName === 'string'
                    ? callRecord.toolName
                    : `call ${callIdx + 1}`
              const callArgs =
                callRecord?.args && typeof callRecord.args === 'object' && !Array.isArray(callRecord.args)
                  ? (callRecord.args as Record<string, any>)
                  : null
              const extraFields = callRecord
                ? Object.fromEntries(
                    Object.entries(callRecord).filter(([callKey]) => callKey !== 'tool' && callKey !== 'toolName' && callKey !== 'args')
                  )
                : null
              // A nested subagent reaches its own transcript from its own card, so a fan-out
              // of several subagents stays navigable without crowding the group header.
              const nestedSubagent = nestedSubagentCalls.find(entry => entry.index === callIdx)

              return (
                <SurfaceCard
                  key={`input-${callIdx}`}
                  index={callIdx}
                  title={toolName}
                  actions={nestedSubagent ? transcriptPill(nestedSubagent.toolCallId) : undefined}
                >
                  <FieldRows record={callArgs} fallback={callArgs ? undefined : { key: 'args', value: callRecord?.args ?? null }} />
                  {extraFields && Object.keys(extraFields).length > 0 && <FieldRows record={extraFields} />}
                </SurfaceCard>
              )
            })}
          </div>
        </div>
      )
    }

    const fieldCount = Object.keys(group.args).length
    return (
      <div className='min-w-0 max-w-full'>
        <SectionLabel label='input'>
          <Badge>{`${fieldCount} field${fieldCount === 1 ? '' : 's'}`}</Badge>
        </SectionLabel>
        <SurfaceCard>
          <FieldRows record={group.args} />
        </SurfaceCard>
      </div>
    )
  }

  const renderResult = (result: { content: any; is_error?: boolean }, resultIdx: number) => {
    const resultKey = `${messageId}-${group.id}-result-${resultIdx}`
    const maybeHtml = extractHtmlFromToolResult(result.content)
    if (maybeHtml?.html) {
      return (
        <div key={resultKey} className={`${SURFACE_CARD_CLASS} p-1`}>
          <HtmlIframe html={maybeHtml.html} toolName={maybeHtml.toolName ?? group.name ?? null} />
        </div>
      )
    }

    const errorTextClass = result.is_error ? 'text-red-600 dark:text-red-400' : ''
    const outputPreview = getGenericToolOutputPreview(result.content)
    if (outputPreview.truncated) {
      return (
        <div key={resultKey} className='min-w-0 max-w-full'>
          <SectionLabel label='output'>
            <Badge>{`result ${resultIdx + 1}`}</Badge>
            <Badge tone='warning'>truncated preview</Badge>
          </SectionLabel>
          <SurfaceCard>
            <div className={`${MONO_DETAIL_CLASS} whitespace-pre-wrap ${errorTextClass}`}>{outputPreview.text}</div>
          </SurfaceCard>
        </div>
      )
    }

    const multiCallOutput = normalizedName === 'multi_call' ? parseToolJsonObject(result.content) : null
    const multiCallResults: any[] | null = Array.isArray(multiCallOutput?.results) ? multiCallOutput.results : null
    if (multiCallResults) {
      return (
        <div key={resultKey} className='min-w-0 max-w-full'>
          <SectionLabel label='output'>
            <Badge>{`${multiCallResults.length} result${multiCallResults.length === 1 ? '' : 's'}`}</Badge>
            {typeof multiCallOutput?.parallel !== 'undefined' && (
              <Badge tone='info'>{`parallel: ${String(multiCallOutput.parallel)}`}</Badge>
            )}
            {typeof multiCallOutput?.stopOnError !== 'undefined' && (
              <Badge tone='warning'>{`stopOnError: ${String(multiCallOutput.stopOnError)}`}</Badge>
            )}
          </SectionLabel>
          <div className='space-y-1.5'>
            {multiCallResults.map((callResult, callResultIdx) => {
              const resultRecord = callResult && typeof callResult === 'object' ? (callResult as Record<string, any>) : null
              const nestedToolName =
                typeof resultRecord?.tool === 'string'
                  ? resultRecord.tool
                  : typeof resultRecord?.toolName === 'string'
                    ? resultRecord.toolName
                    : `result ${callResultIdx + 1}`
              const nestedData = resultRecord?.data
              const extraFields = resultRecord
                ? Object.fromEntries(
                    Object.entries(resultRecord).filter(
                      ([callKey]) => callKey !== 'tool' && callKey !== 'toolName' && callKey !== 'ok' && callKey !== 'data'
                    )
                  )
                : null
              const status = getToolPayloadStatus(resultRecord)
              return (
                <SurfaceCard
                  key={`${resultKey}-multi-${callResultIdx}`}
                  index={callResultIdx}
                  title={nestedToolName}
                  badge={status ? <Badge tone={status.tone}>{status.label}</Badge> : undefined}
                >
                  {typeof nestedData !== 'undefined' && (
                    <FieldRows
                      record={
                        nestedData && typeof nestedData === 'object' && !Array.isArray(nestedData)
                          ? (nestedData as Record<string, any>)
                          : null
                      }
                      fallback={{ key: 'data', value: nestedData }}
                    />
                  )}
                  {extraFields && Object.keys(extraFields).length > 0 && <FieldRows record={extraFields} />}
                </SurfaceCard>
              )
            })}
          </div>
        </div>
      )
    }

    const outputRecord = parseToolJsonObject(result.content)
    const outputStatus = getToolPayloadStatus(outputRecord, result.is_error)
    return (
      <div key={resultKey} className='min-w-0 max-w-full'>
        <SectionLabel label='output'>{group.results.length > 1 && <Badge>{`result ${resultIdx + 1}`}</Badge>}</SectionLabel>
        <SurfaceCard badge={outputStatus ? <Badge tone={outputStatus.tone}>{outputStatus.label}</Badge> : undefined}>
          <div className={errorTextClass}>
            <FieldRows record={outputRecord} fallback={outputRecord ? undefined : { key: 'content', value: result.content }} />
          </div>
        </SurfaceCard>
      </div>
    )
  }

  return (
    <div className='min-w-0 max-w-full' style={wrapperStyle} data-chat-block='tool'>
      <DisclosureRow
        label={label}
        tone={tone}
        summary={
          pathContent ? (
            <span className='block min-w-0 max-w-full truncate' style={{ direction: 'rtl', textAlign: 'left' }} title={pathContent}>
              {pathContent}
            </span>
          ) : undefined
        }
        expanded={expanded}
        onToggle={onToggle}
        controlsId={panelId}
        trailing={hasTrailing ? trailing : undefined}
      />
      <DisclosurePanel
        id={panelId}
        expanded={expanded}
        disableTransition={disableExpandTransition}
        onTransitionEnd={onExpandTransitionEnd}
      >
        <div className='space-y-2'>
          {renderInputs()}
          {/* Results mount only while expanded so truncation reduces DOM work. */}
          {expanded && hasResults && group.results.map(renderResult)}
        </div>
      </DisclosurePanel>
    </div>
  )
}
