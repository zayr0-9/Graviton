import * as Diff from 'diff'
import React, { useMemo, useState } from 'react'
import { AlignLeft, ChevronDown, Columns2, FileText, GitCompareArrows, Minus, Plus, X } from 'lucide-react'
import { getThemeModeColor, useCustomChatTheme, useHtmlDarkMode } from '../ThemeManager/themeConfig'
import ReactMarkdown from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'

export interface EditFileArgs {
  path?: string
  operation?: string
  searchPattern?: string
  replacement?: string
  content?: string // For append operation
  validateContent?: boolean
}

export interface EditFileLineInfo {
  oldStartLine: number
  oldEndLine: number
  oldLineCount: number
  newStartLine: number
  newEndLine: number
  newLineCount: number
  scope?: 'single' | 'first_of_many' | 'append'
}

export interface EditFileResult {
  success?: boolean
  sizeBytes?: number
  replacements?: number
  message?: string
  matchStrategy?: string
  attemptedStrategies?: string[]
  lineInfo?: EditFileLineInfo
}

interface EditFileDiffViewProps {
  args: EditFileArgs
  result: EditFileResult | string
  className?: string
}

type ViewMode = 'unified' | 'split' | 'inline'

function getLanguageFromPath(filePath: string): string {
  if (!filePath) return 'plaintext'
  const ext = filePath.split('.').pop()?.toLowerCase() || ''
  const langMap: Record<string, string> = {
    ts: 'typescript',
    tsx: 'tsx',
    js: 'javascript',
    jsx: 'jsx',
    py: 'python',
    rb: 'ruby',
    go: 'go',
    rs: 'rust',
    java: 'java',
    c: 'c',
    cpp: 'cpp',
    h: 'c',
    hpp: 'cpp',
    cs: 'csharp',
    php: 'php',
    swift: 'swift',
    kt: 'kotlin',
    sql: 'sql',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    xml: 'xml',
    html: 'html',
    css: 'css',
    scss: 'scss',
    less: 'less',
    md: 'markdown',
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
    ps1: 'powershell',
    toml: 'toml',
    ini: 'ini',
    conf: 'ini',
    dockerfile: 'dockerfile',
    vue: 'vue',
    svelte: 'svelte',
  }
  return langMap[ext] || 'plaintext'
}

function parseResult(result: EditFileResult | string): EditFileResult {
  if (typeof result === 'string') {
    try {
      return JSON.parse(result)
    } catch {
      return { message: result }
    }
  }
  return result
}

function getFilename(path: string): string {
  if (!path) return 'unknown'
  return path.split(/[/\\]/).pop() || path
}

interface InlineDiffLineProps {
  type: 'added' | 'removed' | 'unchanged'
  content: string
  oldLineNumber?: number
  newLineNumber?: number
}

const ADDED_TEXT_CLASS = 'text-[color:var(--edit-added,#28714b)] dark:text-[color:var(--edit-added,#9dc5a7)]'
const REMOVED_TEXT_CLASS = 'text-[color:var(--edit-removed,#a64b4b)] dark:text-[color:var(--edit-removed,#dfaaa4)]'
const MUTED_TEXT_CLASS = 'text-[color:var(--edit-muted,#747670)] dark:text-[color:var(--edit-muted,#a2a49c)]'
const DIFF_SURFACE_CLASS =
  'rounded-xl bg-[color:var(--edit-surface,rgba(80,85,75,0.035))] dark:bg-[color:var(--edit-surface,rgba(0,0,0,0.12))]'

const InlineDiffLine: React.FC<InlineDiffLineProps> = ({ type, content, oldLineNumber, newLineNumber }) => {
  const textClass = type === 'added' ? ADDED_TEXT_CLASS : type === 'removed' ? REMOVED_TEXT_CLASS : MUTED_TEXT_CLASS
  const lineNumber = type === 'removed' ? oldLineNumber : newLineNumber
  const lineLabel = type === 'removed' ? `Original line ${oldLineNumber}` : `New line ${newLineNumber}`

  return (
    <div className={`flex min-w-max px-3 font-mono text-[0.625em] leading-[1.85] ${textClass}`}>
      <span
        className='w-10 shrink-0 pr-3.5 text-right text-[color:var(--edit-muted,#94968f)] dark:text-[color:var(--edit-muted,#767970)] select-none'
        title={lineLabel}
        aria-label={lineLabel}
      >
        {lineNumber}
      </span>
      <span className='w-[18px] shrink-0 select-none'>{type === 'added' ? '+' : type === 'removed' ? '−' : ' '}</span>
      <span className='flex-1 whitespace-pre'>{content || ' '}</span>
    </div>
  )
}

interface InlineDiffViewProps {
  original: string
  replacement: string
  lineInfo?: EditFileLineInfo
}

const InlineDiffView: React.FC<InlineDiffViewProps> = ({ original, replacement, lineInfo }) => {
  const diffLines = useMemo(() => {
    const changes = Diff.diffLines(original || '', replacement || '')

    const lines: Array<{
      type: 'added' | 'removed' | 'unchanged'
      content: string
      oldLineNumber?: number
      newLineNumber?: number
    }> = []

    let oldLineNumber = lineInfo?.oldStartLine ?? 1
    let newLineNumber = lineInfo?.newStartLine ?? 1

    changes.forEach(change => {
      const changeLines = change.value.split('\n')
      if (changeLines[changeLines.length - 1] === '') {
        changeLines.pop()
      }

      changeLines.forEach(line => {
        if (change.added) {
          lines.push({ type: 'added', content: line, newLineNumber })
          newLineNumber += 1
        } else if (change.removed) {
          lines.push({ type: 'removed', content: line, oldLineNumber })
          oldLineNumber += 1
        } else {
          lines.push({ type: 'unchanged', content: line, oldLineNumber, newLineNumber })
          oldLineNumber += 1
          newLineNumber += 1
        }
      })
    })

    return lines
  }, [original, replacement, lineInfo])

  return (
    <div className={`${DIFF_SURFACE_CLASS} overflow-auto max-h-[300px] py-2`}>
      {diffLines.map((line, idx) => (
        <InlineDiffLine
          key={idx}
          type={line.type}
          content={line.content}
          oldLineNumber={line.oldLineNumber}
          newLineNumber={line.newLineNumber}
        />
      ))}
    </div>
  )
}

const EditFileDiffViewComponent: React.FC<EditFileDiffViewProps> = ({ args, result, className = '' }) => {
  const [viewMode, setViewMode] = useState<ViewMode>('inline')
  const [expanded, setExpanded] = useState(false)

  const parsedResult = useMemo(() => parseResult(result), [result])
  const filename = useMemo(() => getFilename(args.path || ''), [args.path])

  const isSuccess = parsedResult.success === true
  const hasChanges = (parsedResult.replacements ?? 0) > 0
  const isAppendOperation = (args.operation ?? '').toLowerCase() === 'append'
  const lineInfo = parsedResult.lineInfo
  const { theme, enabled: customThemeEnabled } = useCustomChatTheme()
  const isDarkMode = useHtmlDarkMode()
  const themeStyle = customThemeEnabled ? {
    '--edit-surface': getThemeModeColor(theme.colors.toolJobsCodeBg, isDarkMode),
    '--edit-code-text': getThemeModeColor(theme.colors.toolJobsCodeText, isDarkMode),
    '--edit-muted': getThemeModeColor(theme.colors.toolJobsMutedText, isDarkMode),
    '--edit-added': getThemeModeColor(theme.colors.toolJobsStatusCompletedText, isDarkMode),
    '--edit-removed': getThemeModeColor(theme.colors.toolJobsStatusFailedText, isDarkMode),
    '--edit-active-bg': getThemeModeColor(theme.colors.composerToggleActiveBg, isDarkMode),
    '--edit-active-text': getThemeModeColor(theme.colors.composerToggleActiveText, isDarkMode),
    '--edit-error-bg': getThemeModeColor(theme.colors.toolJobsErrorBg, isDarkMode),
    '--edit-error-border': getThemeModeColor(theme.colors.toolJobsErrorBorder, isDarkMode),
    '--edit-error-text': getThemeModeColor(theme.colors.toolJobsErrorText, isDarkMode),
    color: getThemeModeColor(theme.colors.toolJobsPrimaryText, isDarkMode),
  } as React.CSSProperties : undefined
  const changeCounts = useMemo(() => {
    const changes = Diff.diffLines(isAppendOperation ? '' : args.searchPattern || '',
      isAppendOperation ? args.content || '' : args.replacement || '')
    return changes.reduce((counts, change) => ({
      added: counts.added + (change.added ? change.count ?? 0 : 0),
      removed: counts.removed + (change.removed ? change.count ?? 0 : 0),
    }), { added: 0, removed: 0 })
  }, [isAppendOperation, args.searchPattern, args.content, args.replacement])
  const operationLabel = (args.operation || 'replace').replace(/_/g, ' ')

  const originalMarkdown = useMemo(() => {
    if (!expanded || isAppendOperation || viewMode === 'inline') return ''
    const language = getLanguageFromPath(args.path || '')
    return `\`\`\`${language}\n${args.searchPattern || ''}\n\`\`\``
  }, [args.path, args.searchPattern, expanded, isAppendOperation, viewMode])

  const replacementMarkdown = useMemo(() => {
    if (!expanded || isAppendOperation || viewMode === 'inline') return ''
    const language = getLanguageFromPath(args.path || '')
    return `\`\`\`${language}\n${args.replacement || ''}\n\`\`\``
  }, [args.path, args.replacement, expanded, isAppendOperation, viewMode])

  const codeBlockStyles =
    '[&_pre]:!m-0 [&_pre]:!p-2 [&_pre]:!bg-transparent [&_pre]:!border-0 [&_code]:!text-[0.625em] [&_code]:!leading-snug [&_code]:!font-mono [&_code]:!bg-transparent [&_.hljs]:!bg-transparent [&_pre_code]:!p-0' +
    (customThemeEnabled ? ' [&_code]:!text-[color:var(--edit-code-text)] [&_code_span]:!text-[color:var(--edit-code-text)]' : '')

  return (
    <div className={`leading-none min-w-0 ${className}`} style={themeStyle}>
      <button
        type='button'
        className='flex min-h-[38px] w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left bg-transparent hover:bg-black/[0.025] dark:hover:bg-white/[0.025] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/70 dark:focus-visible:ring-orange-400/70'
        onClick={() => setExpanded(prev => !prev)}
        aria-expanded={expanded}
        aria-label={`${expanded ? 'Collapse' : 'Expand'} edit for ${filename}, ${operationLabel}, preview: ${changeCounts.added} added and ${changeCounts.removed} removed lines${hasChanges && parsedResult.replacements > 1 ? `, ${parsedResult.replacements} replacements` : ''}`}
        title={args.path}
      >
        <FileText className={`h-4 w-4 shrink-0 ${MUTED_TEXT_CLASS}`} aria-hidden='true' />
        <span className='min-w-0 truncate text-[0.625em] font-medium'>{filename}</span>
        <span className={`${DIFF_SURFACE_CLASS} ${MUTED_TEXT_CLASS} hidden sm:inline shrink-0 rounded-full px-2 py-1 text-[0.5625em] capitalize`}>
          {operationLabel}
        </span>
        <span className='flex-1' />
        {hasChanges && parsedResult.replacements > 1 && (
          <span className={`${MUTED_TEXT_CLASS} shrink-0 text-[0.5625em]`}>
            {parsedResult.replacements} replacements
          </span>
        )}
        <span className='flex shrink-0 gap-2 font-mono text-[0.5625em]' aria-label='Preview line changes'>
          {changeCounts.added > 0 && <span className={ADDED_TEXT_CLASS}>+{changeCounts.added}</span>}
          {changeCounts.removed > 0 && <span className={REMOVED_TEXT_CLASS}>−{changeCounts.removed}</span>}
        </span>
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 ${MUTED_TEXT_CLASS} ${expanded ? '' : '-rotate-90'}`} aria-hidden='true' />
      </button>
      {expanded && !isAppendOperation && (
        <div className='flex justify-end gap-1 py-1' role='group' aria-label='Diff view'>
          {([
            { mode: 'inline', label: 'Inline diff (git-style merged)', Icon: GitCompareArrows },
            { mode: 'unified', label: 'Unified view (stacked)', Icon: AlignLeft },
            { mode: 'split', label: 'Split view (side-by-side)', Icon: Columns2 },
          ] as const).map(({ mode, label, Icon }) => (
            <button
              key={mode}
              type='button'
              className={`flex h-7 w-7 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/70 dark:focus-visible:ring-orange-400/70 ${viewMode === mode ? 'bg-[color:var(--edit-active-bg,rgba(80,85,75,0.065))] dark:bg-[color:var(--edit-active-bg,rgba(255,255,255,0.055))] text-[color:var(--edit-active-text)]' : `bg-transparent ${MUTED_TEXT_CLASS} hover:bg-black/5 dark:hover:bg-white/5`}`}
              onClick={() => setViewMode(mode)}
              title={label}
              aria-label={label}
              aria-pressed={viewMode === mode}
            >
              <Icon className='h-3.5 w-3.5' aria-hidden='true' />
            </button>
          ))}
        </div>
      )}
      {expanded && (
        <div className='mt-1 space-y-1'>
          {isAppendOperation || viewMode === 'inline' ? (
            <InlineDiffView
              original={isAppendOperation ? '' : args.searchPattern || ''}
              replacement={isAppendOperation ? args.content || '' : args.replacement || ''}
              lineInfo={lineInfo}
            />
          ) : viewMode === 'unified' ? (
            <div className='space-y-1'>
              <div className='rounded-[10px] overflow-hidden'>
                <div className={`flex items-center gap-1 px-2 py-1 ${REMOVED_TEXT_CLASS}`}>
                  <Minus className='h-3 w-3' aria-label='Original' />
                </div>
                <div className={`${DIFF_SURFACE_CLASS} ${codeBlockStyles} overflow-x-auto`}>
                  <ReactMarkdown rehypePlugins={[[rehypeHighlight, { ignoreMissing: true }]]}>
                    {originalMarkdown}
                  </ReactMarkdown>
                </div>
              </div>

              <div className='rounded-[10px] overflow-hidden'>
                <div className={`flex items-center gap-1 px-2 py-1 ${ADDED_TEXT_CLASS}`}>
                  <Plus className='h-3 w-3' aria-label='Replacement' />
                </div>
                <div className={`${DIFF_SURFACE_CLASS} ${codeBlockStyles} overflow-x-auto`}>
                  <ReactMarkdown rehypePlugins={[[rehypeHighlight, { ignoreMissing: true }]]}>
                    {replacementMarkdown}
                  </ReactMarkdown>
                </div>
              </div>
            </div>
          ) : (
            <div className='grid grid-cols-2 gap-1'>
              <div className='rounded-[10px] overflow-hidden'>
                <div className={`flex items-center gap-1 px-2 py-1 ${REMOVED_TEXT_CLASS}`}>
                  <Minus className='h-3 w-3' aria-label='Original' />
                  <span className='text-[0.5625em] font-medium'>Original</span>
                </div>
                <div
                  className={`${DIFF_SURFACE_CLASS} ${codeBlockStyles} overflow-x-auto max-h-[250px] overflow-y-auto`}
                >
                  <ReactMarkdown rehypePlugins={[[rehypeHighlight, { ignoreMissing: true }]]}>
                    {originalMarkdown}
                  </ReactMarkdown>
                </div>
              </div>

              <div className='rounded-[10px] overflow-hidden'>
                <div className={`flex items-center gap-1 px-2 py-1 ${ADDED_TEXT_CLASS}`}>
                  <Plus className='h-3 w-3' aria-label='Replacement' />
                  <span className='text-[0.5625em] font-medium'>Replacement</span>
                </div>
                <div
                  className={`${DIFF_SURFACE_CLASS} ${codeBlockStyles} overflow-x-auto max-h-[250px] overflow-y-auto`}
                >
                  <ReactMarkdown rehypePlugins={[[rehypeHighlight, { ignoreMissing: true }]]}>
                    {replacementMarkdown}
                  </ReactMarkdown>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
      {expanded && !isSuccess && parsedResult.message && (
        <div
          className='rounded-[10px] flex items-center gap-1.5 px-2 py-1 text-[0.5625em] border font-mono bg-red-50 dark:bg-red-500/5 border-red-200 dark:border-red-500/20 text-red-700 dark:text-red-400/90'
          style={customThemeEnabled ? {
            backgroundColor: 'var(--edit-error-bg)',
            borderColor: 'var(--edit-error-border)',
            color: 'var(--edit-error-text)',
          } : undefined}
        >
          <X className='h-3 w-3 shrink-0' aria-hidden='true' />
          <span className='min-w-0 flex-1 whitespace-pre-wrap break-words'>{parsedResult.message}</span>
          {parsedResult.matchStrategy && parsedResult.matchStrategy !== 'exact' && (
            <span className='px-1 py-0.5 text-[0.5em] uppercase rounded bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-400'>
              {parsedResult.matchStrategy}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

export const EditFileDiffView = React.memo(EditFileDiffViewComponent)
EditFileDiffView.displayName = 'EditFileDiffView'

export default EditFileDiffView
