import React, { useMemo } from 'react'
import { EditFileDiffView, type EditFileArgs, type EditFileResult } from './EditFileDiffView'

interface EditToolDiffViewProps {
  toolName?: string | null
  args?: Record<string, unknown> | null
  result: unknown
  className?: string
}

interface EditToolViewItem {
  key: string
  args: EditFileArgs
  result: EditFileResult | string
  index: number
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

const isRecord = (value: unknown): value is UnknownRecord => typeof value === 'object' && value !== null && !Array.isArray(value)

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

const buildViewModel = (
  toolName: string | null | undefined,
  rawArgs: Record<string, unknown> | null | undefined,
  rawResult: unknown
): EditToolViewModel | null => {
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

export const EditToolDiffView: React.FC<EditToolDiffViewProps> = ({ toolName, args, result, className = '' }) => {
  const viewModel = useMemo(() => buildViewModel(toolName, args, result), [toolName, args, result])

  if (!viewModel || viewModel.items.length === 0) return null

  if (viewModel.mode === 'single') {
    const item = viewModel.items[0]
    return <EditFileDiffView args={item.args} result={item.result} className={className} />
  }

  const showSummaryMessage = Boolean(viewModel.message) && (viewModel.success === false || viewModel.stoppedEarly)

  return (
    <div className={className}>
      <div className='mobile-tool-block'>
        <div className='mobile-tool-kv'>
          <span className='mobile-tool-k'>summary:</span>{' '}
          <span className='mobile-tool-v'>{viewModel.items.length} edits</span>
        </div>
        {typeof viewModel.applied === 'number' ? (
          <div className='mobile-tool-kv'>
            <span className='mobile-tool-k'>applied:</span> <span className='mobile-tool-v'>{viewModel.applied}</span>
          </div>
        ) : null}
        {typeof viewModel.failed === 'number' ? (
          <div className='mobile-tool-kv'>
            <span className='mobile-tool-k'>failed:</span> <span className='mobile-tool-v'>{viewModel.failed}</span>
          </div>
        ) : null}
        {viewModel.stoppedEarly ? (
          <div className='mobile-tool-kv'>
            <span className='mobile-tool-k'>status:</span> <span className='mobile-tool-v'>stopped early</span>
          </div>
        ) : null}
      </div>

      {viewModel.items.map(item => (
        <div key={item.key} className='mobile-tool-block'>
          <div className='mobile-tool-kv'>
            <span className='mobile-tool-k'>edit {item.index + 1}:</span>{' '}
            <span className='mobile-tool-v'>{item.args.path || item.args.operation || 'edit'}</span>
          </div>
          <EditFileDiffView args={item.args} result={item.result} className='mobile-editfile-view' />
        </div>
      ))}

      {showSummaryMessage ? (
        <div className={`mobile-tool-result ${viewModel.success === false ? 'error' : 'success'}`}>
          <pre>{viewModel.message}</pre>
        </div>
      ) : null}
    </div>
  )
}

export default EditToolDiffView
