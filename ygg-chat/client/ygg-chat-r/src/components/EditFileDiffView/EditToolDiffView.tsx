import React, { useMemo, useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { EditFileDiffView, type EditFileArgs, type EditFileResult } from './EditFileDiffView'
import type { ClaudeFilePatch, ClaudeFilePatchHunk } from '../../../../../shared/claudeProvider'

interface EditToolDiffViewProps {
  toolName?: string | null
  args?: Record<string, unknown> | null
  result: unknown
  className?: string
  /** Native Claude tools: the result is prose, so status comes from the tool_result flag. */
  isError?: boolean
  patch?: ClaudeFilePatch
}

interface EditToolViewItem {
  key: string
  args: EditFileArgs
  result: EditFileResult | string
  index: number
  hunks?: ClaudeFilePatchHunk[]
}

interface EditToolViewModel {
  mode: 'single' | 'multi'
  items: EditToolViewItem[]
  success?: boolean
  message?: string
  applied?: number
  failed?: number
  stoppedEarly?: boolean
}

type UnknownRecord = Record<string, unknown>

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const normalizeToolName = (name: string | null | undefined): string =>
  String(name || '')
    .toLowerCase()
    .replace(/[-\s]/g, '_')

const parseResultRecord = (rawResult: unknown): UnknownRecord => {
  if (typeof rawResult === 'string') {
    try {
      const parsed = JSON.parse(rawResult)
      return isRecord(parsed) ? parsed : { message: rawResult }
    } catch {
      return { message: rawResult }
    }
  }

  return isRecord(rawResult) ? rawResult : {}
}

const toOptionalString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)
const toOptionalBoolean = (value: unknown): boolean | undefined => (typeof value === 'boolean' ? value : undefined)
const toOptionalNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

const buildEditArgs = (rawArgs: UnknownRecord, fallback: UnknownRecord = {}): EditFileArgs => ({
  path: toOptionalString(rawArgs.path) ?? toOptionalString(fallback.path),
  operation: toOptionalString(rawArgs.operation) ?? toOptionalString(fallback.operation),
  searchPattern: toOptionalString(rawArgs.searchPattern) ?? toOptionalString(fallback.searchPattern),
  replacement: toOptionalString(rawArgs.replacement) ?? toOptionalString(fallback.replacement),
  content: toOptionalString(rawArgs.content) ?? toOptionalString(fallback.content),
  validateContent: toOptionalBoolean(rawArgs.validateContent) ?? toOptionalBoolean(fallback.validateContent),
})

const buildEditResult = (rawResult: unknown): EditFileResult | string => {
  if (typeof rawResult === 'string') return rawResult
  return isRecord(rawResult) ? (rawResult as EditFileResult) : {}
}

// Native errors arrive wrapped as `<tool_use_error>…</tool_use_error>`.
const nativeErrorMessage = (rawResult: unknown): string | undefined => {
  const text = typeof rawResult === 'string' ? rawResult : undefined
  return text?.replace(/<\/?tool_use_error>/g, '').trim() || undefined
}

/** Claude's native Edit/Write, mapped onto edit_file's args so the same diff view draws them. */
const buildNativeClaudeViewModel = (
  toolName: string,
  rawArgs: UnknownRecord,
  rawResult: unknown,
  isError: boolean | undefined,
  patch: ClaudeFilePatch | undefined
): EditToolViewModel | null => {
  const path = toOptionalString(rawArgs.file_path) ?? patch?.filePath
  const args: EditFileArgs = toolName === 'Edit'
    ? {
        path,
        operation: rawArgs.replace_all === true ? 'replace_all' : 'replace',
        searchPattern: toOptionalString(rawArgs.old_string),
        replacement: toOptionalString(rawArgs.new_string),
      }
    : {
        path,
        // Old rows have no patch; their Write is drawn as the content it wrote.
        operation: patch?.kind === 'update' ? 'overwrite' : patch?.kind === 'create' ? 'create' : 'write',
        content: toOptionalString(rawArgs.content),
      }
  // An overwrite is only meaningful as its hunks; without them it falls back to the written content.
  if (args.operation === 'overwrite' && !patch?.hunks.length) args.operation = 'write'
  const result: EditFileResult = isError === undefined ? {} : isError
    ? { success: false, message: nativeErrorMessage(rawResult) }
    : { success: true }
  return {
    mode: 'single',
    items: [{ key: path ?? 'edit-0', args, result, index: 0, hunks: patch?.hunks.length ? patch.hunks : undefined }],
    success: result.success,
    message: result.message,
  }
}

const buildViewModel = (
  toolName: string | null | undefined,
  rawArgs: Record<string, unknown> | null | undefined,
  rawResult: unknown,
  isError?: boolean,
  patch?: ClaudeFilePatch
): EditToolViewModel | null => {
  if ((toolName === 'Edit' || toolName === 'Write') && rawArgs && isRecord(rawArgs)) {
    return buildNativeClaudeViewModel(toolName, rawArgs, rawResult, isError, patch)
  }

  const normalizedToolName = normalizeToolName(toolName)
  const parsedResult = parseResultRecord(rawResult)

  if ((normalizedToolName === 'edit_file' || normalizedToolName === 'editfile') && rawArgs && isRecord(rawArgs)) {
    return {
      mode: 'single',
      items: [
        {
          key: toOptionalString(rawArgs.path) ?? 'edit-0',
          args: buildEditArgs(rawArgs),
          result: buildEditResult(rawResult),
          index: 0,
        },
      ],
      success: toOptionalBoolean(parsedResult.success),
      message: toOptionalString(parsedResult.message),
    }
  }

  if (normalizedToolName !== 'multi_edit' || !rawArgs || !isRecord(rawArgs)) {
    return null
  }

  const rawEdits = Array.isArray(rawArgs.edits) ? rawArgs.edits.filter(isRecord) : []
  const rawResults = Array.isArray(parsedResult.results) ? parsedResult.results.filter(isRecord) : []
  const itemCount = rawResults.length > 0 ? rawResults.length : rawEdits.length

  if (itemCount === 0) return null

  const items: EditToolViewItem[] = Array.from({ length: itemCount }, (_, index) => {
    const editArgs = rawEdits[index] ?? {}
    const itemResult = rawResults[index] ?? {}
    const itemPath = toOptionalString(editArgs.path) ?? toOptionalString(itemResult.path) ?? `edit-${index + 1}`

    return {
      key: `${itemPath}-${index}`,
      args: buildEditArgs(editArgs, itemResult),
      result: buildEditResult(itemResult),
      index,
    }
  })

  return {
    mode: 'multi',
    items,
    success: toOptionalBoolean(parsedResult.success),
    message: toOptionalString(parsedResult.message),
    applied: toOptionalNumber(parsedResult.applied),
    failed: toOptionalNumber(parsedResult.failed),
    stoppedEarly: toOptionalBoolean(parsedResult.stoppedEarly),
  }
}

const EditToolDiffViewComponent: React.FC<EditToolDiffViewProps> = ({ toolName, args, result, className = '', isError, patch }) => {
  const viewModel = useMemo(() => buildViewModel(toolName, args, result, isError, patch), [toolName, args, result, isError, patch])
  const [expanded, setExpanded] = useState(false)

  if (!viewModel || viewModel.items.length === 0) return null

  if (viewModel.mode === 'single') {
    const item = viewModel.items[0]
    return <EditFileDiffView args={item.args} result={item.result} className={className} hunks={item.hunks} />
  }

  const summaryTone =
    viewModel.success === false
      ? 'border-red-200 bg-red-50 text-red-700 dark:border-red-500/20 dark:bg-red-500/5 dark:text-red-300'
      : 'text-neutral-700 dark:text-neutral-300'
  const showSummaryMessage = Boolean(viewModel.message) && (viewModel.success === false || viewModel.stoppedEarly)

  return (
    <div className={`space-y-2 ${className}`}>
      <div
        className={`flex flex-wrap items-center gap-1.5 rounded-[4px] px-2 py-1 text-[0.625em] cursor-pointer select-none ${summaryTone}`}
        onClick={() => setExpanded(prev => !prev)}
      >
        <span>
          {viewModel.items.length} edit{viewModel.items.length === 1 ? '' : 's'}
        </span>
        {typeof viewModel.applied === 'number' ? <span>applied {viewModel.applied}</span> : null}
        {typeof viewModel.failed === 'number' && viewModel.failed > 0 ? <span>failed {viewModel.failed}</span> : null}
        {viewModel.stoppedEarly ? <span>stopped early</span> : null}
        <span className='ml-auto'>
          {expanded ? <ChevronUp className='w-3 h-3' /> : <ChevronDown className='w-3 h-3' />}
        </span>
      </div>

      {expanded && (
        <div className='space-y-1 edit-batch-reveal'>
          {viewModel.items.map(item => (
            <EditFileDiffView key={item.key} args={item.args} result={item.result} editNumber={item.index + 1} />
          ))}

          {showSummaryMessage ? (
            <div className={`rounded-[10px] border px-2 py-1 text-[0.625em] font-mono ${summaryTone}`}>
              {viewModel.message}
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
}

export const EditToolDiffView = React.memo(EditToolDiffViewComponent)
EditToolDiffView.displayName = 'EditToolDiffView'

export default EditToolDiffView
