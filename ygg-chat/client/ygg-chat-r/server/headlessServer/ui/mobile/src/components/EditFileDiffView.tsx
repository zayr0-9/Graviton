import * as Diff from 'diff'
import React, { useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'

export interface EditFileArgs {
  path?: string
  operation?: string
  searchPattern?: string
  replacement?: string
  content?: string
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
  result: EditFileResult | string | unknown
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

function parseResult(result: EditFileResult | string | unknown): EditFileResult {
  if (typeof result === 'string') {
    try {
      return JSON.parse(result)
    } catch {
      return { message: result }
    }
  }
  if (result && typeof result === 'object') {
    return result as EditFileResult
  }
  return {}
}

function getFilename(path: string): string {
  if (!path) return 'unknown'
  const normalized = path.replace(/\\/g, '/')
  return normalized.split('/').pop() || normalized
}

interface InlineDiffLineProps {
  type: 'added' | 'removed' | 'unchanged'
  content: string
  oldLineNumber?: number
  newLineNumber?: number
}

const InlineDiffLine: React.FC<InlineDiffLineProps> = ({ type, content, oldLineNumber, newLineNumber }) => {
  return (
    <div className={`m-edit-inline-row ${type}`}>
      <span className='m-edit-ln'>{oldLineNumber ?? ''}</span>
      <span className='m-edit-ln'>{newLineNumber ?? ''}</span>
      <span className='m-edit-sign'>{type === 'added' ? '+' : type === 'removed' ? '−' : ' '}</span>
      <span className='m-edit-code'>{content || ' '}</span>
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
      if (changeLines[changeLines.length - 1] === '') changeLines.pop()

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
    <div className='m-edit-inline-wrap'>
      <div className='m-edit-inline-head'>
        <span className='m-edit-ln'>old</span>
        <span className='m-edit-ln'>new</span>
        <span className='m-edit-sign'>±</span>
        <span className='m-edit-code'>code</span>
      </div>
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

export const EditFileDiffView: React.FC<EditFileDiffViewProps> = ({ args, result, className = '' }) => {
  const [viewMode, setViewMode] = useState<ViewMode>('inline')

  const parsedResult = useMemo(() => parseResult(result), [result])
  const language = useMemo(() => getLanguageFromPath(args.path || ''), [args.path])
  const filename = useMemo(() => getFilename(args.path || ''), [args.path])

  const isSuccess = parsedResult.success === true
  const hasChanges = (parsedResult.replacements ?? 0) > 0
  const isAppendOperation = (args.operation ?? '').toLowerCase() === 'append'
  const lineInfo = parsedResult.lineInfo

  const originalMarkdown = useMemo(() => {
    return `\`\`\`${language}\n${args.searchPattern || ''}\n\`\`\``
  }, [args.searchPattern, language])

  const replacementMarkdown = useMemo(() => {
    const text = isAppendOperation ? args.content || '' : args.replacement || ''
    return `\`\`\`${language}\n${text}\n\`\`\``
  }, [args.replacement, args.content, language, isAppendOperation])

  return (
    <div className={`m-edit-root ${className}`}>
      <div className='m-edit-head'>
        <div className='m-edit-head-left'>
          <span className='m-edit-op'>{args.operation || 'replace'}</span>
          <span className='m-edit-file' title={args.path || ''}>
            {filename}
          </span>
        </div>

        <div className='m-edit-head-right'>
          {hasChanges ? <span className='m-edit-pill success'>{parsedResult.replacements}</span> : null}

          {lineInfo ? (
            <span className='m-edit-pill info' title='Real file line anchors (old/new)'>
              L{lineInfo.oldStartLine} → L{lineInfo.newStartLine}
            </span>
          ) : null}

          {lineInfo?.scope === 'first_of_many' ? <span className='m-edit-pill warn'>first hunk</span> : null}

          {!isAppendOperation ? (
            <div className='m-edit-toggle'>
              <button className={viewMode === 'inline' ? 'active' : ''} onClick={() => setViewMode('inline')}>
                inline
              </button>
              <button className={viewMode === 'unified' ? 'active' : ''} onClick={() => setViewMode('unified')}>
                unified
              </button>
              <button className={viewMode === 'split' ? 'active' : ''} onClick={() => setViewMode('split')}>
                split
              </button>
            </div>
          ) : null}
        </div>
      </div>

      <div className='m-edit-body'>
        {isAppendOperation ? (
          <InlineDiffView original='' replacement={args.content || ''} lineInfo={lineInfo} />
        ) : viewMode === 'inline' ? (
          <InlineDiffView original={args.searchPattern || ''} replacement={args.replacement || ''} lineInfo={lineInfo} />
        ) : viewMode === 'unified' ? (
          <div className='m-edit-unified'>
            <div className='m-edit-pane removed'>
              <div className='m-edit-pane-head'>−</div>
              <div className='m-edit-pane-body markdown-body'>
                <ReactMarkdown rehypePlugins={[[rehypeHighlight, { ignoreMissing: true }]]}>{originalMarkdown}</ReactMarkdown>
              </div>
            </div>

            <div className='m-edit-pane added'>
              <div className='m-edit-pane-head'>+</div>
              <div className='m-edit-pane-body markdown-body'>
                <ReactMarkdown rehypePlugins={[[rehypeHighlight, { ignoreMissing: true }]]}>{replacementMarkdown}</ReactMarkdown>
              </div>
            </div>
          </div>
        ) : (
          <div className='m-edit-split'>
            <div className='m-edit-pane removed'>
              <div className='m-edit-pane-head'>Original</div>
              <div className='m-edit-pane-body markdown-body'>
                <ReactMarkdown rehypePlugins={[[rehypeHighlight, { ignoreMissing: true }]]}>{originalMarkdown}</ReactMarkdown>
              </div>
            </div>

            <div className='m-edit-pane added'>
              <div className='m-edit-pane-head'>Replacement</div>
              <div className='m-edit-pane-body markdown-body'>
                <ReactMarkdown rehypePlugins={[[rehypeHighlight, { ignoreMissing: true }]]}>{replacementMarkdown}</ReactMarkdown>
              </div>
            </div>
          </div>
        )}
      </div>

      {parsedResult.message ? (
        <div className={`m-edit-msg ${isSuccess ? 'success' : 'error'}`}>
          <span>{parsedResult.message}</span>
          {parsedResult.matchStrategy && parsedResult.matchStrategy !== 'exact' ? (
            <span className='m-edit-pill warn'>{parsedResult.matchStrategy}</span>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
